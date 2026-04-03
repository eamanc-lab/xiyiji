import { EventEmitter } from 'events'
import { copyFileSync, existsSync, mkdirSync, unlinkSync, readdirSync, rmdirSync, writeFileSync, renameSync } from 'fs'
import { join, basename, dirname } from 'path'
import { v4 as uuidv4 } from 'uuid'
import { createHash } from 'crypto'
import { getActiveBackend, getActiveBackendType, isNativeRendererBackendType } from './lipsync-backend'
import type { FrameBatchInfo } from './lipsync-types'
import {
  queryPlayerPosition,
  sendPlayerSeek,
  sendPlayerGapSeek,
  getPlayerStreamQueueState
} from '../ipc/player.ipc'
import { ttsService } from './tts.service'
import { getDataDir } from '../config'
import {
  getAudioDuration,
  extractVideoInfo,
  cutVideoSegment,
  splitAudioByDuration,
  concatVideoFiles
} from '../utils/ffmpeg'

export type TaskSource = 'tts' | 'file' | 'danmaku' | 'manual'
export type TaskStatus = 'queued' | 'copying' | 'submitted' | 'processing' | 'completed' | 'failed'

export interface PipelineTask {
  id: string
  avatarVideoPath: string
  audioPath: string
  source: TaskSource
  sourceText?: string
  status: TaskStatus
  f2fTaskId?: string
  resultVideoPath?: string
  progress: number
  error?: string
  createdAt: number
  isSegmented?: boolean
  isStreaming?: boolean
  audioDuration?: number           // seconds, set by processTask after ffprobe
  firstChunkTime?: number          // ms timestamp when first chunk was sent to player
  totalChunks?: number             // total video chunks produced by streaming F2F
  chunkDirPath?: string            // directory containing chunk files; set so LivePipeline can clean up when fully played
  streamTransport?: 'chunk' | 'frame_batch'
}

const POLL_INTERVAL = 2000
const MAX_POLL_TIME = 600000 // 10 minutes
const MIN_CHUNK_DURATION = 3.0 // don't create chunks shorter than this

function resolveFrameIndexMode(): 'forward' | 'pingpong' {
  const raw = (process.env.DIANJT_FRAME_INDEX_MODE || 'forward').trim().toLowerCase()
  return raw === 'pingpong' ? 'pingpong' : 'forward'
}

export class PipelineService extends EventEmitter {
  private queue: PipelineTask[] = []
  private currentTask: PipelineTask | null = null
  private avatarVideoPath: string = ''
  private cameraRefreshPending = false
  private isProcessing = false
  private pollTimers: NodeJS.Timeout[] = []
  private readonly maxInFlightTtsTasks = (() => {
    const raw = Number(process.env.PIPELINE_MAX_INFLIGHT_TTS || '2')
    if (!Number.isFinite(raw)) return 2
    return Math.max(1, Math.min(16, Math.floor(raw)))
  })()
  private readonly ttsBackpressurePollMs = (() => {
    const raw = Number(process.env.PIPELINE_TTS_BACKPRESSURE_POLL_MS || '80')
    if (!Number.isFinite(raw)) return 80
    return Math.max(20, Math.min(1000, Math.floor(raw)))
  })()
  private readonly maxPlayerBufferedChunks = (() => {
    const raw = Number(process.env.PIPELINE_MAX_PLAYER_CHUNKS || '10')
    if (!Number.isFinite(raw)) return 10
    return Math.max(1, Math.min(120, Math.floor(raw)))
  })()
  private readonly maxPlayerBufferedFrameSegments = (() => {
    const raw = Number(process.env.PIPELINE_MAX_PLAYER_FRAME_SEGMENTS || '3')
    if (!Number.isFinite(raw)) return 3
    return Math.max(1, Math.min(24, Math.floor(raw)))
  })()
  private readonly strictTestFlow = (process.env.DIANJT_STRICT_TEST_FLOW || '1').trim() !== '0'
  private readonly playerBackpressurePollMs = (() => {
    const raw = Number(process.env.PIPELINE_PLAYER_BACKPRESSURE_POLL_MS || '80')
    if (!Number.isFinite(raw)) return 80
    return Math.max(20, Math.min(1000, Math.floor(raw)))
  })()
  private playerBackpressureTimer: NodeJS.Timeout | null = null
  private lastPlayerBackpressureLogAt = 0
  private currentTaskCancelHandle: {
    taskId: string
    promise: Promise<never>
    reject: (reason?: unknown) => void
  } | null = null

  // Avatar segmentation state for seamless body movement
  private avatarTotalDuration: number = 0
  private cumulativeOffset: number = 0
  private avatarDurationCached: string = ''

  // Frame sync: adaptive inference delay estimate (seconds)
  // Covers host inference latency between ACK and first output frame.
  // DIANJT host path is typically around ~1.8s in current profile; using this as
  // initial seed avoids first-sentence start_frame mismatch after app restart.
  private estimatedInferenceDelay = 1.8

  // Deferred seek time: set by each streaming task, flushed to player only when queue is empty.
  // This prevents the player from switching to idle between consecutive tasks.
  private pendingSeekTime: number = 0

  // Tracks where the next task should start in the avatar bounce cycle.
  // -1 means "query the live player position" (used for the first task of a new sequence).
  // For consecutive tasks we skip the player query and use the mathematically exact
  // continuation frame so body pose is seamless across sentence boundaries.
  private nextStartFrame: number = -1
  private frameIndexMode: 'forward' | 'pingpong' = resolveFrameIndexMode()

  // Global avatar clock (single source of truth) for frame-sync across all streaming tasks.
  // nextStartFrame remains as an explicit carry value, but this clock keeps advancing during
  // inter-task gaps so re-entry does not jump.
  private avatarClockFrame: number = -1
  private avatarClockUpdatedAtMs: number = 0
  private avatarClockFps: number = 25
  private avatarClockCycleLen: number = 0

  private getCycleLen(nFrames: number): number {
    const n = Math.max(1, Math.floor(nFrames))
    if (this.frameIndexMode === 'forward') return n
    if (n <= 1) return 1
    return Math.max(1, 2 * n - 2)
  }

  private normalizeFrame(frame: number, cycleLen: number): number {
    const c = Math.max(1, Math.floor(cycleLen))
    const f = Math.floor(Number.isFinite(frame) ? frame : 0)
    return ((f % c) + c) % c
  }

  private setAvatarClock(frame: number, fps: number, nFrames: number, reason: string): void {
    const cycleLen = this.getCycleLen(nFrames)
    this.avatarClockFps = fps > 0 ? fps : 25
    this.avatarClockCycleLen = cycleLen
    this.avatarClockFrame = this.normalizeFrame(frame, cycleLen)
    this.avatarClockUpdatedAtMs = Date.now()
    this.nextStartFrame = this.avatarClockFrame
    console.log(
      `[Pipeline] Avatar clock set frame=${this.avatarClockFrame} cycleLen=${cycleLen} fps=${this.avatarClockFps.toFixed(2)} reason=${reason}`
    )
  }

  private getPredictedAvatarClockFrame(offsetSec = 0): number {
    if (this.avatarClockFrame < 0 || this.avatarClockCycleLen <= 0) return -1
    const nowMs = Date.now()
    const elapsedSec = Math.max(0, (nowMs - this.avatarClockUpdatedAtMs) / 1000)
    const totalSec = elapsedSec + Math.max(0, offsetSec)
    const advance = Math.floor(totalSec * Math.max(1, this.avatarClockFps))
    return this.normalizeFrame(this.avatarClockFrame + advance, this.avatarClockCycleLen)
  }

  private resetAvatarClock(): void {
    this.nextStartFrame = -1
    this.avatarClockFrame = -1
    this.avatarClockUpdatedAtMs = 0
    this.avatarClockFps = 25
    this.avatarClockCycleLen = 0
  }

  private createTaskCancelledError(): Error {
    const err = new Error('cancelled')
    err.name = 'PipelineTaskCancelledError'
    return err
  }

  private isTaskCancelled(task: PipelineTask): boolean {
    return task.status === 'failed' && task.error === 'cancelled'
  }

  private throwIfTaskCancelled(task: PipelineTask): void {
    if (this.isTaskCancelled(task)) {
      throw this.createTaskCancelledError()
    }
  }

  private createTaskCancelHandle(taskId: string): {
    taskId: string
    promise: Promise<never>
    reject: (reason?: unknown) => void
  } {
    let reject!: (reason?: unknown) => void
    const promise = new Promise<never>((_, rej) => {
      reject = rej
    })
    promise.catch(() => {
      // Suppress unhandled rejection noise when cancel lands between awaited stages.
    })
    return { taskId, promise, reject }
  }

  private rejectCurrentTaskCancellation(): void {
    const handle = this.currentTaskCancelHandle
    if (!handle) return
    this.currentTaskCancelHandle = null
    handle.reject(this.createTaskCancelledError())
  }

  private async awaitTask<T>(task: PipelineTask, operation: Promise<T>): Promise<T> {
    this.throwIfTaskCancelled(task)
    const handle = this.currentTaskCancelHandle
    const guardedOperation =
      handle && handle.taskId === task.id
        ? Promise.race<T | never>([operation, handle.promise])
        : operation
    const result = await guardedOperation
    this.throwIfTaskCancelled(task)
    return result
  }

  setAvatarVideo(videoPath: string): void {
    this.avatarVideoPath = videoPath
    this.cumulativeOffset = 0
    this.avatarTotalDuration = 0
    this.avatarDurationCached = ''
    this.resetAvatarClock() // New avatar = new sequence; must re-query player position
    this.emit('avatar-changed', videoPath)
  }

  getAvatarVideo(): string {
    return this.avatarVideoPath
  }

  /**
   * Called when camera captures a new reference frame.
   * Updates the avatar path and flags for re-init at the next sentence boundary.
   */
  refreshCameraAvatar(newPath: string): void {
    // NOTE: Camera re-init has been disabled. The 30s idle re-capture was causing
    // catastrophic disruption (stream interruption, failed face detection, underruns).
    // The initial 4s recording provides stable face coordinates; frame injection
    // provides the live camera background during inference.
    console.log('[Pipeline] Camera refresh ignored (re-init disabled):', newPath)
  }

  private cameraFramePath = ''
  private cameraFramePathSentToBackend = false
  private faceTrackingStarted = false

  /**
   * Write live camera frame to shared file for Python post-processing.
   * Python reads this in put_frame() to composite DIANJT's mouth output
   * onto the live camera frame. Only the mouth region is replaced.
   * Called by player IPC at ~5fps during camera mode.
   */
  injectCameraFrame(jpegBase64: string): void {
    try {
      if (!this.cameraFramePath) {
        const dataDir = getDataDir()
        this.cameraFramePath = join(dataDir, 'face2face', 'camera_live_frame.jpg')
        mkdirSync(dirname(this.cameraFramePath), { recursive: true })
      }
      // Retry sending path to backend until it succeeds (fixes race condition
      // where first frame arrives before F2F server is ready)
      if (!this.cameraFramePathSentToBackend) {
        try {
          const backend = getActiveBackend()
          if (backend.setCameraFramePath) {
            backend.setCameraFramePath(this.cameraFramePath)
            this.cameraFramePathSentToBackend = true
          }
        } catch {
          // Server not ready yet — will retry on next frame
        }
      }
      // NOTE: Camera frame is used for POST-PROCESSING only (mouth-only compositing).
      // DIANJT processes the static video normally; Python put_frame() reads this file
      // and composites only the mouth region onto the live camera.
      const buf = Buffer.from(jpegBase64, 'base64')
      const tmpPath = this.cameraFramePath + '.tmp'
      writeFileSync(tmpPath, buf)
      renameSync(tmpPath, this.cameraFramePath)
    } catch {
      // Write failed — silently ignore
    }
  }

  /**
   * Clear live camera frame injection.
   */
  clearCameraFrame(): void {
    try {
      if (this.cameraFramePath && existsSync(this.cameraFramePath)) {
        try { unlinkSync(this.cameraFramePath) } catch { /* ignore */ }
      }
      this.cameraFramePath = ''
      this.cameraFramePathSentToBackend = false
      this.faceTrackingStarted = false
      const backend = getActiveBackend()
      backend.clearCameraFrame?.()
    } catch {
      // Ignore
    }
  }

  /**
   * Ensure audio file is in the heygem_data directory so Docker container can access it.
   */
  private ensureInDataDir(filePath: string): string {
    const dataDir = getDataDir()
    const normalized = filePath.replace(/\\/g, '/')
    const dataNormalized = dataDir.replace(/\\/g, '/')

    if (normalized.startsWith(dataNormalized)) {
      return filePath
    }

    const pipelineDir = join(dataDir, 'face2face', 'audio')
    if (!existsSync(pipelineDir)) {
      mkdirSync(pipelineDir, { recursive: true })
    }

    const destName = `${uuidv4()}_${basename(filePath)}`
    const destPath = join(pipelineDir, destName)
    copyFileSync(filePath, destPath)
    return destPath
  }

  /**
   * Ensure avatar video is accessible by Docker container.
   */
  private ensureAvatarInDataDir(videoPath: string): string {
    const dataDir = getDataDir()
    const normalized = videoPath.replace(/\\/g, '/')
    const dataNormalized = dataDir.replace(/\\/g, '/')

    if (normalized.startsWith(dataNormalized)) {
      return videoPath
    }

    const avatarDir = join(dataDir, 'face2face', 'video')
    if (!existsSync(avatarDir)) {
      mkdirSync(avatarDir, { recursive: true })
    }

    // Keep a deterministic local path so the active lip-sync backend can reuse
    // cached avatar preprocessing across consecutive tasks.
    const srcHash = createHash('md5').update(videoPath).digest('hex').slice(0, 8)
    const destName = `avatar_${srcHash}_${basename(videoPath)}`
    const destPath = join(avatarDir, destName)
    if (!existsSync(destPath)) {
      copyFileSync(videoPath, destPath)
    }
    return destPath
  }

  /**
   * Get avatar video total duration (cached).
   */
  private async getAvatarDuration(avatarPath: string): Promise<number> {
    if (this.avatarDurationCached === avatarPath && this.avatarTotalDuration > 0) {
      return this.avatarTotalDuration
    }
    const info = await extractVideoInfo(avatarPath)
    this.avatarTotalDuration = info.duration
    this.avatarDurationCached = avatarPath
    return this.avatarTotalDuration
  }

  /**
   * Cut an avatar video segment matching the audio duration.
   * Maintains cumulative offset for seamless body movement across chunks.
   */
  private async cutAvatarSegment(avatarPath: string, audioDuration: number): Promise<string> {
    const totalDuration = await this.getAvatarDuration(avatarPath)

    if (audioDuration >= totalDuration) {
      this.cumulativeOffset = 0
      return avatarPath
    }

    let startSec = this.cumulativeOffset % totalDuration

    if (startSec + audioDuration > totalDuration) {
      startSec = 0
    }

    const dataDir = getDataDir()
    const segmentDir = join(dataDir, 'face2face', 'video', 'segments')
    if (!existsSync(segmentDir)) {
      mkdirSync(segmentDir, { recursive: true })
    }
    const segmentPath = join(segmentDir, `seg_${uuidv4()}.mp4`)

    await cutVideoSegment(avatarPath, startSec, audioDuration, segmentPath)
    this.cumulativeOffset = startSec + audioDuration

    console.log(`[Pipeline] Avatar segment: ${startSec.toFixed(1)}s ~ ${(startSec + audioDuration).toFixed(1)}s / ${totalDuration.toFixed(1)}s`)

    return segmentPath
  }

  resetOffset(): void {
    this.cumulativeOffset = 0
  }

  enqueue(audioPath: string, source: TaskSource, sourceText?: string): PipelineTask {
    if (!this.avatarVideoPath) {
      throw new Error('Avatar video not set. Call setAvatarVideo first.')
    }

    const task: PipelineTask = {
      id: uuidv4(),
      avatarVideoPath: this.avatarVideoPath,
      audioPath,
      source,
      sourceText,
      status: 'queued',
      progress: 0,
      createdAt: Date.now()
    }

    this.queue.push(task)
    this.emit('task:status-change', task)
    this.processNext()
    return task
  }

  private getInFlightTaskCount(): number {
    return this.queue.length + (this.currentTask ? 1 : 0)
  }

  private async waitForTtsSlot(stage: 'before-synth' | 'before-enqueue'): Promise<void> {
    const start = Date.now()
    let warned = false

    while (this.getInFlightTaskCount() >= this.maxInFlightTtsTasks) {
      if (!warned && Date.now() - start >= 1200) {
        warned = true
        console.log(
          `[Pipeline] TTS backpressure hold (${stage}): inFlight=${this.getInFlightTaskCount()}, max=${this.maxInFlightTtsTasks}`
        )
      }
      await new Promise<void>((resolve) => setTimeout(resolve, this.ttsBackpressurePollMs))
    }

    if (warned) {
      console.log(
        `[Pipeline] TTS backpressure released (${stage}): inFlight=${this.getInFlightTaskCount()}, waited=${Date.now() - start}ms`
      )
    }
  }

  async enqueueTts(
    text: string,
    voice: string,
    speed: number = 1.0,
    source: TaskSource = 'tts'
  ): Promise<PipelineTask> {
    if (!this.avatarVideoPath) {
      throw new Error('Avatar video not set. Call setAvatarVideo first.')
    }

    await this.waitForTtsSlot('before-synth')
    console.log(`[Pipeline] enqueueTts: voice=${voice}, text="${text.slice(0, 40)}"`)
    const { audioPath } = await ttsService.synthesize(voice, text, speed)
    await this.waitForTtsSlot('before-enqueue')
    return this.enqueue(audioPath, source, text)
  }

  private scheduleProcessNext(delayMs: number): void {
    if (this.playerBackpressureTimer) return
    this.playerBackpressureTimer = setTimeout(() => {
      this.playerBackpressureTimer = null
      void this.processNext()
    }, Math.max(20, delayMs))
  }

  private async processNext(): Promise<void> {
    if (this.isProcessing) return
    if (this.queue.length === 0) {
      // All tasks done: keep avatarClock alive across queue-empty gaps so the next task
      // can re-enter frame-stream without a pose jump. Only flush deferred idle seek.
      if (this.pendingSeekTime > 0) {
        sendPlayerSeek(this.pendingSeekTime)
        this.pendingSeekTime = 0
      }
      this.emit('pipeline:idle')
      return
    }

    const now = Date.now()
    const playerQueue = getPlayerStreamQueueState()
    const playerStateFresh = playerQueue.updatedAt > 0 && now - playerQueue.updatedAt <= 5000
    const playerInStreamMode =
      playerQueue.mode === 'streaming' || playerQueue.mode === 'frame-streaming'
    const maxBuffered =
      playerQueue.mode === 'frame-streaming'
        ? this.maxPlayerBufferedFrameSegments
        : this.maxPlayerBufferedChunks
    if (
      playerStateFresh &&
      playerInStreamMode &&
      playerQueue.depth >= maxBuffered
    ) {
      if (now - this.lastPlayerBackpressureLogAt >= 1000) {
        this.lastPlayerBackpressureLogAt = now
        console.log(
          `[Pipeline] Player queue backpressure hold: depth=${playerQueue.depth}, max=${maxBuffered}, mode=${playerQueue.mode}`
        )
      }
      this.scheduleProcessNext(this.playerBackpressurePollMs)
      return
    }

    this.isProcessing = true
    this.emit('pipeline:busy')

    const task = this.queue.shift()!
    this.currentTask = task
    this.currentTaskCancelHandle = this.createTaskCancelHandle(task.id)

    try {
      await this.processTask(task)
    } catch (err: any) {
      if (this.isTaskCancelled(task) || err?.name === 'PipelineTaskCancelledError' || err?.message === 'cancelled') {
        task.status = 'failed'
        task.error = 'cancelled'
        console.log(`[Pipeline] Task cancelled: ${task.id}`)
      } else {
        console.error(`[Pipeline] Task failed: ${err.message || err}`)
        task.status = 'failed'
        task.error = err.message || String(err)
        this.emit('task:status-change', task)
        this.emit('task:failed', task)
      }
    } finally {
      if (this.currentTaskCancelHandle?.taskId === task.id) {
        this.currentTaskCancelHandle = null
      }
      this.currentTask = null
      this.isProcessing = false
      this.processNext()
    }
  }

  private async processTask(task: PipelineTask): Promise<void> {
    this.throwIfTaskCancelled(task)
    task.status = 'copying'
    this.emit('task:status-change', task)

    const accessibleAudio = this.ensureInDataDir(task.audioPath)
    const accessibleAvatar = this.ensureAvatarInDataDir(task.avatarVideoPath)
    task.audioPath = accessibleAudio

    const backend = getActiveBackend()

    // Fast path: when append stream is already active, skip expensive overhead
    // (ffprobe, probeInstances, initAvatar) and go straight to append_audio.
    // This eliminates the 500ms-1s gap between sentences that causes mouth
    // close→open stutter at sentence boundaries.
    if (
      backend.processAudioStream &&
      backend.initAvatar &&
      backend.hasActiveAppendStream?.()
    ) {
      console.log('[Pipeline] Fast-path: append stream active, skipping ffprobe/probe overhead')
      task.audioDuration = 0 // not critical for append mode
      return this.processStreaming(task, accessibleAvatar, accessibleAudio)
    }

    const audioDuration = await this.awaitTask(task, getAudioDuration(accessibleAudio))
    task.audioDuration = audioDuration
    console.log(`[Pipeline] Audio duration: ${audioDuration.toFixed(1)}s`)

    // Probe how many backend instances are running
    const availableInstances = await this.awaitTask(task, backend.probeInstances())
    console.log(`[Pipeline] Backend=${backend.name}, available instances: [${availableInstances.join(', ')}]`)

    if (this.strictTestFlow && (!backend.processAudioStream || !backend.initAvatar)) {
      throw new Error(
        '[Pipeline][STRICT] Backend does not provide streaming API; strict DIANJT test-flow requires processAudioStream+initAvatar'
      )
    }

    // Use streaming mode if backend supports it
    if (backend.processAudioStream && backend.initAvatar) {
      return this.processStreaming(task, accessibleAvatar, accessibleAudio)
    }

    // Use parallel mode if multiple instances available and audio is long enough
    if (availableInstances.length > 1 && audioDuration > MIN_CHUNK_DURATION * 2) {
      return this.processParallel(task, accessibleAvatar, accessibleAudio, audioDuration, availableInstances)
    }

    // Fallback: single instance
    const instanceIdx = availableInstances.length > 0 ? availableInstances[0] : 0
    return this.processSingleShot(task, accessibleAvatar, accessibleAudio, audioDuration, instanceIdx)
  }

  /**
   * Streaming mode: persistent GPU server generates video chunks incrementally.
   * Each chunk is emitted to the player as soon as it's ready.
   */
  private async processStreaming(
    task: PipelineTask,
    avatarPath: string,
    audioPath: string
  ): Promise<void> {
    const backend = getActiveBackend()
    const activeBackendType = getActiveBackendType()
    const isNativeRendererBackend = isNativeRendererBackendType(activeBackendType)
    task.isStreaming = true
    const streamTransport = backend.getStreamingTransport?.() || 'chunk'
    task.streamTransport = streamTransport
    if (this.strictTestFlow && streamTransport !== 'frame_batch' && !isNativeRendererBackend) {
      throw new Error(
        `[Pipeline][STRICT] Expected frame_batch transport, got "${streamTransport}". ` +
          'Formal flow is locked to DIANJT append stream.'
      )
    }

    // Step 1: Initialize avatar (may be cached from previous task)
    task.status = 'submitted'
    task.progress = 5
    this.emit('task:status-change', task)

    // Skip initAvatar when append stream is already running (avatar is loaded).
    // Exception: camera refresh pending → close old stream and re-init with new reference.
    if (!backend.hasActiveAppendStream?.()) {
      console.log('[Pipeline] Streaming mode: initializing avatar...')
      await this.awaitTask(task, backend.initAvatar!(avatarPath))
      this.cameraRefreshPending = false
    } else if (this.cameraRefreshPending) {
      this.cameraRefreshPending = false
      console.log('[Pipeline] Camera reference changed, closing append stream and re-initializing avatar...')
      backend.resetStreamingSession?.()
      await this.awaitTask(task, backend.initAvatar!(avatarPath))
    } else {
      console.log('[Pipeline] Streaming mode: append session active, skipping initAvatar')
    }

    // Step 2: Process audio with two-phase frame sync
    // Position query happens in onAck callback (after feature extraction, before inference)
    task.status = 'processing'
    task.progress = 10
    this.emit('task:status-change', task)

    console.log('[Pipeline] Streaming mode: processing audio...')

    const avatarInfo = backend.getAvatarInfo?.()
    let ackTime = 0
    let startFrame = 0
    let firstChunkTime = 0
    let chunkDirPath = ''
    let expectedFrames = 0
    let emittedFrameCount = 0

    // onAck: called after Python finishes feature extraction, before inference starts.
    // frame_batch path must align to visible player timeline (playerTime + delay),
    // because backend "done" can arrive before player drains its render queue.
    const onAck = async (_numFrames: number, _totalChunks: number): Promise<number> => {
      if (this.isTaskCancelled(task)) return 0
      expectedFrames = Math.max(1, Number(_numFrames || 0))
      ackTime = Date.now()
      if (avatarInfo && avatarInfo.nFrames > 0) {
        const fps = avatarInfo.fps > 0 ? avatarInfo.fps : 25
        const cycleLen = this.getCycleLen(avatarInfo.nFrames)
        const offsetSec = Math.max(0, this.estimatedInferenceDelay)

        if (streamTransport === 'frame_batch') {
          // In frame transport, prefer continuous avatar clock first.
          // Querying player position can take up to IPC timeout and may delay set_start_frame.
          const clockPred = this.getPredictedAvatarClockFrame(offsetSec)
          if (clockPred >= 0 && this.avatarClockCycleLen === cycleLen) {
            startFrame = this.normalizeFrame(clockPred, cycleLen)
            this.setAvatarClock(startFrame, fps, avatarInfo.nFrames, 'frame_batch-avatarClock')
            console.log(
              `[Pipeline] Frame sync: frame_batch avatarClock startFrame=${startFrame} offset=${offsetSec.toFixed(2)}s`
            )
            return startFrame
          }

          const position = await queryPlayerPosition()
          if (this.isTaskCancelled(task)) return 0
          if (position) {
            const predictedTime = position.currentTime + offsetSec
            startFrame = this.normalizeFrame(Math.floor(predictedTime * fps), cycleLen)
            this.setAvatarClock(startFrame, fps, avatarInfo.nFrames, 'frame_batch-player')
            console.log(
              `[Pipeline] Frame sync: frame_batch playerTime=${position.currentTime.toFixed(3)}s + inferenceDelay=${offsetSec.toFixed(2)}s -> startFrame=${startFrame}`
            )
            return startFrame
          }
        } else {
          if (isNativeRendererBackend && this.nextStartFrame >= 0) {
            startFrame = this.normalizeFrame(this.nextStartFrame, cycleLen)
            this.setAvatarClock(startFrame, fps, avatarInfo.nFrames, 'chunk-exact-carry')
            console.log(
              `[Pipeline] Frame sync: chunk exact carry startFrame=${startFrame} ` +
                `backend=${activeBackendType || backend.name}`
            )
            return startFrame
          }

          // chunk mode: prefer continuation clock, fallback to player position.
          const clockPred = this.getPredictedAvatarClockFrame(offsetSec)
          if (clockPred >= 0 && this.avatarClockCycleLen === cycleLen) {
            startFrame = clockPred
            console.log(
              `[Pipeline] Frame sync: chunk avatarClock startFrame=${startFrame} offset=${offsetSec.toFixed(2)}s`
            )
            return startFrame
          }
          const position = await queryPlayerPosition()
          if (this.isTaskCancelled(task)) return 0
          if (position) {
            const predictedTime = position.currentTime + offsetSec
            startFrame = this.normalizeFrame(Math.floor(predictedTime * fps), cycleLen)
            this.setAvatarClock(startFrame, fps, avatarInfo.nFrames, 'chunk-seed-player')
            console.log(
              `[Pipeline] Frame sync: chunk playerTime=${position.currentTime.toFixed(3)}s + inferenceDelay=${offsetSec.toFixed(2)}s -> startFrame=${startFrame}`
            )
            return startFrame
          }
        }
      }
      startFrame = 0
      if (avatarInfo && avatarInfo.nFrames > 0 && this.avatarClockFrame < 0 && this.nextStartFrame < 0) {
        console.log('[Pipeline] Frame sync: initial startFrame=0 (avatar/player info unavailable yet)')
      } else {
        console.warn('[Pipeline] Frame sync: fallback startFrame=0 (avatar/player info unavailable)')
      }
      return 0
    }

    const onChunk = (chunk: {
      path: string
      chunkIdx: number
      totalChunks: number
      audioPath?: string
      nFrames: number
    }) => {
      if (this.isTaskCancelled(task)) return
      if (this.strictTestFlow && streamTransport === 'frame_batch') {
        console.warn('[Pipeline][STRICT] Unexpected chunk event in frame_batch mode; ignored')
        return
      }
      // Capture chunk directory from first chunk's path.
      if (!chunkDirPath && chunk.path) {
        chunkDirPath = chunk.path.replace(/[/\\][^/\\]+$/, '')
      }
      // Measure actual inference delay (ack -> first output) for self-tuning.
      if (chunk.chunkIdx === 0) {
        firstChunkTime = Date.now()
        task.firstChunkTime = firstChunkTime
        const actualInferenceDelay = ackTime > 0 ? (firstChunkTime - ackTime) / 1000 : 0
        this.estimatedInferenceDelay = actualInferenceDelay * 0.7 + this.estimatedInferenceDelay * 0.3
        console.log(
          `[Pipeline] Frame sync: actual inference delay=${actualInferenceDelay.toFixed(2)}s, updated estimate=${this.estimatedInferenceDelay.toFixed(2)}s`
        )
      }

      if (streamTransport === 'chunk') {
        const progress = 10 + Math.round((chunk.chunkIdx / chunk.totalChunks) * 85)
        task.progress = progress
        this.emit('task:status-change', task)
        this.emit(
          'task:chunk-ready',
          task,
          chunk.path,
          chunk.chunkIdx,
          chunk.totalChunks,
          chunk.audioPath,
          chunk.nFrames
        )
      }
    }

    const onFrameBatch = (batch: FrameBatchInfo) => {
      if (this.isTaskCancelled(task)) return
      if (streamTransport !== 'frame_batch') return
      if (emittedFrameCount === 0) {
        firstChunkTime = Date.now()
        task.firstChunkTime = firstChunkTime
        const actualInferenceDelay = ackTime > 0 ? (firstChunkTime - ackTime) / 1000 : 0
        this.estimatedInferenceDelay = actualInferenceDelay * 0.7 + this.estimatedInferenceDelay * 0.3
        console.log(
          `[Pipeline] Frame sync: actual inference delay=${actualInferenceDelay.toFixed(2)}s, updated estimate=${this.estimatedInferenceDelay.toFixed(2)}s`
        )
      }
      const nFrames = Math.max(0, Array.isArray(batch.frames) ? batch.frames.length : 0)
      emittedFrameCount += nFrames
      if (expectedFrames > 0) {
        const ratio = Math.max(0, Math.min(1, emittedFrameCount / expectedFrames))
        task.progress = 10 + Math.round(ratio * 85)
        this.emit('task:status-change', task)
      }
      this.emit('task:frame-batch-ready', task, batch)
    }

    const result = await this.awaitTask(
      task,
      backend.processAudioStream!(audioPath, onChunk, onAck, onFrameBatch)
    )
    const rawEndFrame = (result as { endFrame?: unknown }).endFrame
    const explicitEndFrame =
      rawEndFrame !== null &&
      rawEndFrame !== undefined &&
      rawEndFrame !== '' &&
      Number.isFinite(Number(rawEndFrame))
        ? Number(rawEndFrame)
        : undefined

    task.totalChunks = result.totalChunks
    task.chunkDirPath = chunkDirPath || undefined
    console.log(
      `[Pipeline] Streaming complete: transport=${streamTransport}, ${result.totalChunks} chunks, ${result.totalFrames} frames`
    )

    let resolvedEndFrameForTask = -1
    let seekFrameForTask = -1

    // Step 3a: Track continuation offset.
    // For frame_batch, do NOT advance clock on backend done: player may still be draining queued frames.
    if (avatarInfo && avatarInfo.nFrames > 1) {
      const cycleLen = this.getCycleLen(avatarInfo.nFrames)
      if (streamTransport === 'chunk') {
        resolvedEndFrameForTask =
          explicitEndFrame !== undefined
            ? this.normalizeFrame(explicitEndFrame, cycleLen)
            : this.normalizeFrame(startFrame + Math.max(0, result.totalFrames) - 1, cycleLen)
        seekFrameForTask = this.normalizeFrame(resolvedEndFrameForTask + 1, cycleLen)
        this.nextStartFrame = seekFrameForTask
        this.setAvatarClock(this.nextStartFrame, avatarInfo.fps, avatarInfo.nFrames, 'task-complete')
        console.log(
          `[Pipeline] Frame sync: nextStartFrame=${this.nextStartFrame} ` +
            `(cycleLen=${cycleLen}, endFrame=${resolvedEndFrameForTask})`
        )
      } else {
        this.nextStartFrame = -1
      }
    }

    // Step 3b: Compute the idle-resume seek time for this task.
    // Do NOT send it to the player yet; defer until the queue is fully empty so the player
    // never switches back to idle between consecutive tasks (fixes inter-sentence jump).
    if (streamTransport === 'chunk' && avatarInfo && avatarInfo.nFrames > 0) {
      const cycleLen = this.getCycleLen(avatarInfo.nFrames)
      const endFrame =
        resolvedEndFrameForTask >= 0
          ? resolvedEndFrameForTask
          : explicitEndFrame !== undefined
            ? this.normalizeFrame(explicitEndFrame, cycleLen)
            : this.normalizeFrame(startFrame + Math.max(0, result.totalFrames) - 1, cycleLen)
      const seekFrame =
        seekFrameForTask >= 0
          ? seekFrameForTask
          : this.normalizeFrame(endFrame + 1, cycleLen)
      const seekTime = seekFrame / avatarInfo.fps
      console.log(
        `[Pipeline] Frame sync: endFrame=${endFrame} -> seekFrame=${seekFrame} ` +
          `-> seekTime=${seekTime.toFixed(3)}s (deferred until queue empty)`
      )
      this.pendingSeekTime = seekTime // will be sent when queue drains

      // Send gap seek immediately so the player can show the moving idle video during
      // the brief gap between consecutive tasks (instead of a frozen synthesis frame).
      // Only active when idleSeekTime hasn't been set yet (i.e., queue still has tasks).
      sendPlayerGapSeek(seekTime)
    } else if (streamTransport === 'frame_batch') {
      // Frame transport keeps idle video continuously running underneath; no chunk-gap seek needed.
      this.pendingSeekTime = 0
    }

    task.status = 'completed'
    task.progress = 100
    this.emit('task:status-change', task)
    this.emit('task:completed', task)

    // Schedule cleanup of this task's chunk files only
    if (streamTransport === 'chunk' && chunkDirPath) {
      this.scheduleChunkCleanup(chunkDirPath)
    }
  }

  /**
   * Immediately delete a chunk directory. Called by LivePipelineService when the player
   * has confirmed playing all chunks of a task (chunk-based cleanup, always correct).
   */
  cleanupChunkDir(chunkDir: string): void {
    if (!chunkDir || !existsSync(chunkDir)) return
    try {
      const files = readdirSync(chunkDir)
      for (const f of files) {
        try { unlinkSync(join(chunkDir, f)) } catch { /* ignore */ }
      }
      rmdirSync(chunkDir)
      console.log(`[Pipeline] Cleaned up chunk directory: ${chunkDir}`)
    } catch { /* ignore */ }
  }

  /**
   * Schedule chunk directory cleanup as a safety fallback (e.g. for non-live-pipeline modes
   * such as chat). In live mode, LivePipelineService cleans up via cleanupChunkDir() first
   * and this timer finds the directory already gone (no-op).
   */
  private scheduleChunkCleanup(chunkDir: string): void {
    if (!existsSync(chunkDir)) return

    // Safety fallback: delete after 10 minutes in case chunk-based cleanup never fires.
    // In live mode, cleanupChunkDir() fires first (immediately on last-chunk-played) and
    // this timer becomes a no-op. In chat/single-shot mode the player queue is small so
    // 10 minutes is a generous but acceptable margin.
    setTimeout(() => {
      this.cleanupChunkDir(chunkDir)
    }, 600000) // 10 min safety net
  }

  /**
   * Single-shot processing using one F2F instance.
   */
  private async processSingleShot(
    task: PipelineTask,
    avatarPath: string,
    audioPath: string,
    audioDuration: number,
    instanceIdx: number = 0
  ): Promise<void> {
    let avatarForF2f: string
    if (audioDuration > 0) {
      avatarForF2f = await this.awaitTask(task, this.cutAvatarSegment(avatarPath, audioDuration))
    } else {
      avatarForF2f = avatarPath
      console.warn('[Pipeline] Could not detect audio duration, using full avatar')
    }

    task.status = 'submitted'
    this.emit('task:status-change', task)

    const { task_id } = await this.awaitTask(task, getActiveBackend().submit(avatarForF2f, audioPath, instanceIdx))
    task.f2fTaskId = task_id

    task.status = 'processing'
    this.emit('task:status-change', task)

    const result = await this.awaitTask(task, this.pollUntilDone(task, task_id, instanceIdx))

    if (avatarForF2f !== avatarPath) {
      try { unlinkSync(avatarForF2f) } catch { /* ignore */ }
    }

    if (result.status === 'completed' && result.result_path) {
      task.status = 'completed'
      task.resultVideoPath = result.result_path
      task.progress = 100
      this.emit('task:status-change', task)
      this.emit('task:completed', task)
    } else {
      task.status = 'failed'
      task.error = result.error || 'F2F processing failed with no result'
      this.emit('task:status-change', task)
      this.emit('task:failed', task)
    }
  }

  /**
   * Parallel generation: split audio across multiple F2F instances,
   * wait for all to complete, then concatenate into one continuous video.
   */
  private async processParallel(
    task: PipelineTask,
    avatarPath: string,
    audioPath: string,
    totalDuration: number,
    availableInstances: number[]
  ): Promise<void> {
    task.isSegmented = true
    const numWorkers = availableInstances.length
    const chunkDuration = Math.max(totalDuration / numWorkers, MIN_CHUNK_DURATION)

    console.log(`[Pipeline] Parallel mode: ${totalDuration.toFixed(1)}s audio, ${numWorkers} workers, ~${chunkDuration.toFixed(1)}s/chunk`)

    // Split audio into chunks (one per worker)
    const audioChunks = await this.awaitTask(task, splitAudioByDuration(audioPath, chunkDuration))
    const totalChunks = audioChunks.length
    console.log(`[Pipeline] Split into ${totalChunks} chunks for ${numWorkers} workers`)

    // Prepare avatar segments for each chunk (must be sequential for cumulative offset)
    task.status = 'submitted'
    this.emit('task:status-change', task)

    const chunkData: Array<{
      audioChunk: string
      avatarSeg: string
      isAvatarTemp: boolean
      instanceIdx: number
    }> = []

    for (let i = 0; i < audioChunks.length; i++) {
      const chunkAudio = audioChunks[i]
      const chunkDur = await this.awaitTask(task, getAudioDuration(chunkAudio))
      let avatarSeg: string
      if (chunkDur > 0) {
        avatarSeg = await this.awaitTask(task, this.cutAvatarSegment(avatarPath, chunkDur))
      } else {
        avatarSeg = avatarPath
      }
      chunkData.push({
        audioChunk: chunkAudio,
        avatarSeg,
        isAvatarTemp: avatarSeg !== avatarPath,
        instanceIdx: availableInstances[i % numWorkers]
      })
    }

    // Submit ALL chunks in parallel to different instances
    const submissions = await this.awaitTask(task, Promise.all(
      chunkData.map(async (cd, i) => {
        const { task_id } = await getActiveBackend().submit(cd.avatarSeg, cd.audioChunk, cd.instanceIdx)
        console.log(`[Pipeline] Chunk ${i}/${totalChunks} -> instance ${cd.instanceIdx}, task=${task_id}`)
        return { taskId: task_id, instanceIdx: cd.instanceIdx }
      })
    ))

    // Poll ALL chunks in parallel
    task.status = 'processing'
    task.progress = 0
    this.emit('task:status-change', task)

    let completedCount = 0
    const results = await this.awaitTask(task, Promise.all(
      submissions.map(async (sub, i) => {
        const result = await this.pollUntilDone(task, sub.taskId, sub.instanceIdx)
        completedCount++
        task.progress = Math.round((completedCount / totalChunks) * 90) // 90% for generation, 10% for concat
        this.emit('task:status-change', task)
        // Emit chunk-ready for UI progress
        this.emit('task:chunk-ready', task, result.result_path, i, totalChunks, undefined, undefined)
        console.log(`[Pipeline] Chunk ${i} done (${completedCount}/${totalChunks}): ${result.status}`)
        return result
      })
    ))

    // Clean up avatar segments
    for (const cd of chunkData) {
      if (cd.isAvatarTemp) {
        try { unlinkSync(cd.avatarSeg) } catch { /* ignore */ }
      }
    }

    // Check all succeeded
    const failedIdx = results.findIndex(r => r.status !== 'completed' || !r.result_path)
    if (failedIdx !== -1) {
      task.status = 'failed'
      task.error = results[failedIdx].error || `Chunk ${failedIdx} failed`
      this.emit('task:status-change', task)
      this.emit('task:failed', task)
      this.cleanupChunkFiles(audioChunks, audioPath)
      return
    }

    // Concatenate all chunk results into one continuous video
    console.log('[Pipeline] Concatenating chunk results...')
    const chunkVideoPaths = results.map(r => r.result_path!)
    const dataDir = getDataDir()
    const mergedPath = join(dataDir, 'face2face', 'result', `${task.id}-merged.mp4`)
    await this.awaitTask(task, concatVideoFiles(chunkVideoPaths, mergedPath))

    task.progress = 100
    task.status = 'completed'
    task.resultVideoPath = mergedPath
    this.emit('task:status-change', task)
    this.emit('task:completed', task)

    // Clean up temp chunk files
    this.cleanupChunkFiles(audioChunks, audioPath)
    for (const p of chunkVideoPaths) {
      try { unlinkSync(p) } catch { /* ignore */ }
    }
    console.log(`[Pipeline] Parallel complete: ${mergedPath}`)
  }

  private cleanupChunkFiles(chunks: string[], originalAudio: string): void {
    for (const c of chunks) {
      if (c !== originalAudio) {
        try { unlinkSync(c) } catch { /* ignore */ }
      }
    }
  }

  /**
   * Poll a specific F2F instance until task is done.
   */
  private pollUntilDone(
    task: PipelineTask,
    f2fTaskId: string,
    instanceIdx: number = 0
  ): Promise<{ status: string; result_path?: string; error?: string }> {
    return new Promise((resolve, reject) => {
      const startTime = Date.now()

      const poll = async () => {
        if (task.status === 'failed' && task.error === 'cancelled') {
          resolve({ status: 'failed', error: 'cancelled' })
          return
        }

        try {
          const result = await getActiveBackend().query(f2fTaskId, instanceIdx)

          if (result.status === 'completed') {
            resolve(result)
            return
          }

          if (result.status === 'failed') {
            resolve(result)
            return
          }

          if (Date.now() - startTime > MAX_POLL_TIME) {
            resolve({ status: 'failed', error: 'Polling timeout exceeded' })
            return
          }

          const timer = setTimeout(poll, POLL_INTERVAL)
          this.pollTimers.push(timer)
        } catch (err: any) {
          if (Date.now() - startTime > MAX_POLL_TIME) {
            reject(new Error(`Polling failed: ${err.message}`))
            return
          }
          const timer = setTimeout(poll, POLL_INTERVAL)
          this.pollTimers.push(timer)
        }
      }

      poll()
    })
  }

  cancel(taskId?: string): void {
    if (taskId) {
      const idx = this.queue.findIndex((t) => t.id === taskId)
      if (idx !== -1) {
        const task = this.queue.splice(idx, 1)[0]
        task.status = 'failed'
        task.error = 'cancelled'
        this.emit('task:status-change', task)
      }
      if (this.currentTask?.id === taskId) {
        this.currentTask.status = 'failed'
        this.currentTask.error = 'cancelled'
        this.rejectCurrentTaskCancellation()
      }
    } else {
      this.cancelAll()
    }
  }

  cancelAll(): void {
    console.log(`[Pipeline] cancelAll: queue=${this.queue.length}, isProcessing=${this.isProcessing}, currentTask=${this.currentTask?.id || 'none'}`)
    for (const task of this.queue) {
      task.status = 'failed'
      task.error = 'cancelled'
      this.emit('task:status-change', task)
    }
    this.queue = []

    if (this.currentTask) {
      this.currentTask.status = 'failed'
      this.currentTask.error = 'cancelled'
      this.rejectCurrentTaskCancellation()
    }

    for (const timer of this.pollTimers) {
      clearTimeout(timer)
    }
    this.pollTimers = []

    // Clear backpressure timer to prevent stale processNext() firing after cancel
    if (this.playerBackpressureTimer) {
      clearTimeout(this.playerBackpressureTimer)
      this.playerBackpressureTimer = null
    }

    try {
      const backend = getActiveBackend()
      backend.resetStreamingSession?.()
    } catch {
      // ignore if backend unavailable during cancel
    }

    this.cumulativeOffset = 0
    this.resetAvatarClock()

    // Flush any pending seek time immediately so the player exits streaming mode now.
    // Use pendingSeekTime if available, otherwise 0.001 as a non-zero sentinel.
    const exitSeek = this.pendingSeekTime > 0 ? this.pendingSeekTime : 0.001
    this.pendingSeekTime = 0
    sendPlayerSeek(exitSeek)
  }

  getStatus(): {
    isProcessing: boolean
    currentTask: PipelineTask | null
    queueLength: number
    queue: PipelineTask[]
  } {
    return {
      isProcessing: this.isProcessing,
      currentTask: this.currentTask,
      queueLength: this.queue.length,
      queue: [...this.queue]
    }
  }
}

export const pipelineService = new PipelineService()
