/**
 * yundingyunbo.service.ts — LipSyncBackend implementation that delegates
 * to yundingyunbo's V2Manager via a NDJSON bridge script.
 *
 * V2Manager renders frames internally (OpenCV window / virtual camera),
 * so this backend does NOT produce chunk files or frame_batch data.
 * The pipeline should treat each audio as a single "virtual chunk" that
 * completes when V2Manager finishes playback.
 */

import { execFile, spawn, type ChildProcess } from 'child_process'
import { createInterface, type Interface } from 'readline'
import { delimiter, dirname, join, resolve } from 'path'
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs'
import { v4 as uuidv4 } from 'uuid'
import { EventEmitter } from 'events'
import { promisify } from 'util'
import { getConfig, getDataDir } from '../config'
import type { LipSyncBackend } from './lipsync-backend'
import type { ChunkInfo, FrameBatchInfo } from './lipsync-types'
import { getPortableYundingyunboCandidates } from '../utils/app-paths'
import { prepareYdbAvatarVideo } from '../utils/yundingyunbo-avatar'

const DEFAULT_BRIDGE_SCRIPT = 'yundingyunbo_bridge'
const BRIDGE_START_TIMEOUT_MS = 300_000
const INIT_AVATAR_TIMEOUT_MS = Math.max(
  BRIDGE_START_TIMEOUT_MS,
  Number.parseInt(process.env.YDB_INIT_AVATAR_TIMEOUT_MS || '18000000', 10) || 18_000_000,
)
const PING_TIMEOUT_MS = 10_000
const PROCESS_AUDIO_TIMEOUT_MS = 300_000 // 5 min max per audio
const execFileAsync = promisify(execFile)

export function resolveYdbAvatarInitPaths(options: {
  inputPath: string
  preparedVideoPath: string
  cameraMode: boolean
}): {
  referenceVideoPath: string
  drivingVideoPath: string
} {
  const inputPath = (options.inputPath || '').trim()
  const preparedVideoPath = (options.preparedVideoPath || '').trim() || inputPath
  const cameraMode = options.cameraMode === true

  if (!cameraMode) {
    const sourceVideoPath = inputPath || preparedVideoPath
    return {
      referenceVideoPath: preparedVideoPath || sourceVideoPath,
      drivingVideoPath: sourceVideoPath,
    }
  }

  return {
    referenceVideoPath: preparedVideoPath,
    drivingVideoPath: preparedVideoPath,
  }
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

export function resolveYundingyunboBase(): string {
  // 1. Environment variable
  const envBase = (process.env.YUNDINGYUNBO_BASE || '').trim()
  if (envBase && existsSync(join(envBase, 'live'))) return envBase

  // 2. Config
  const cfgBase = getConfig('yundingyunbo_base').trim()
  if (cfgBase && existsSync(join(cfgBase, 'live'))) return cfgBase

  const candidates = [
    ...getPortableYundingyunboCandidates()
  ]

  for (const p of candidates) {
    if (existsSync(join(p, 'live'))) return resolve(p)
  }

  return getPortableYundingyunboCandidates()[0]
}

export function resolveYundingyunboPython(base: string): string {
  const envPython = (process.env.YUNDINGYUNBO_PYTHON || '').trim()
  if (envPython) return envPython
  // yundingyunbo ships Python 3.10 in env/
  return join(base, 'env', 'python.exe')
}

export function findBridgeScript(bridgeScriptBaseName: string = DEFAULT_BRIDGE_SCRIPT): string {
  const names = [`${bridgeScriptBaseName}.py`, `${bridgeScriptBaseName}.pyc`]
  const bases = [
    join(process.resourcesPath || '', 'resources', 'scripts'),
    join(process.resourcesPath || '', 'scripts'),
    resolve(__dirname, '..', '..', 'resources', 'scripts'),
    join(process.cwd(), 'resources', 'scripts'),
  ]
  for (const base of bases) {
    for (const name of names) {
      const p = join(base, name)
      if (existsSync(p)) return resolve(p)
    }
  }
  throw new Error(`${names.join(' / ')} not found. Looked in:\n${bases.join('\n')}`)
}

export function findYundingyunboOverlayRoot(): string {
  const candidates = [
    join(process.resourcesPath || '', 'resources', 'yundingyunbo-overlay'),
    join(process.resourcesPath || '', 'yundingyunbo-overlay'),
    resolve(__dirname, '..', '..', 'resources', 'yundingyunbo-overlay'),
    join(process.cwd(), 'resources', 'yundingyunbo-overlay'),
  ]

  for (const candidate of candidates) {
    if (existsSync(candidate)) return resolve(candidate)
  }

  return ''
}

export function syncDirectoryContents(sourceDir: string, targetDir: string): number {
  let copiedFiles = 0

  if (!existsSync(sourceDir)) {
    return copiedFiles
  }

  mkdirSync(targetDir, { recursive: true })

  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = join(sourceDir, entry.name)
    const targetPath = join(targetDir, entry.name)

    if (entry.isDirectory()) {
      copiedFiles += syncDirectoryContents(sourcePath, targetPath)
      continue
    }

    if (!entry.isFile()) {
      continue
    }

    const sourceStat = statSync(sourcePath)
    const targetExists = existsSync(targetPath)
    const targetStat = targetExists ? statSync(targetPath) : null
    const shouldCopy =
      !targetExists ||
      !targetStat ||
      sourceStat.size !== targetStat.size ||
      sourceStat.mtimeMs > targetStat.mtimeMs + 1

    if (shouldCopy) {
      mkdirSync(dirname(targetPath), { recursive: true })
      copyFileSync(sourcePath, targetPath)
      copiedFiles += 1
    }
  }

  return copiedFiles
}

export function ensureYundingyunboRuntimeOverlay(base: string): void {
  const overlayRoot = findYundingyunboOverlayRoot()
  if (!overlayRoot || !existsSync(base)) {
    return
  }

  try {
    const copiedFiles = syncDirectoryContents(overlayRoot, base)
    if (copiedFiles > 0) {
      console.log(`[YDB] Applied runtime overlay: files=${copiedFiles} root=${overlayRoot}`)
    }
  } catch (err: any) {
    console.warn(`[YDB] Failed to apply runtime overlay: ${err?.message || err}`)
  }
}

function uniqueExistingDirs(paths: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []

  for (const rawPath of paths) {
    const value = rawPath?.trim()
    if (!value) continue
    const resolved = resolve(value)
    if (!existsSync(resolved) || seen.has(resolved)) continue
    seen.add(resolved)
    result.push(resolved)
  }

  return result
}

export function getPortableNodeDirs(base: string): string[] {
  return uniqueExistingDirs([
    process.env.XIYIJI_NODE_DIR || '',
    join(base, 'node'),
    join(base, 'nodejs'),
    join(process.resourcesPath || '', 'resources', 'scripts', 'node'),
    join(process.resourcesPath || '', 'resources', 'node'),
    join(process.cwd(), 'resources', 'scripts', 'node'),
    join(process.cwd(), 'resources', 'node'),
  ])
}

export function getPortableFfmpegDirs(base: string): string[] {
  return uniqueExistingDirs([
    process.env.XIYIJI_FFMPEG_DIR || '',
    join(base, 'env', 'ffmpeg', 'bin'),
    join(base, 'env_50', 'ffmpeg', 'bin'),
    join(process.resourcesPath || '', 'resources', 'ffmpeg'),
    join(process.resourcesPath || '', 'ffmpeg'),
    join(process.cwd(), 'resources', 'ffmpeg'),
  ])
}

function buildRuntimePath(extraDirs: string[], currentPath: string): string {
  return [...new Set([...extraDirs, ...(currentPath || '').split(delimiter).filter(Boolean)])].join(delimiter)
}

// ---------------------------------------------------------------------------
// Pending request tracking
// ---------------------------------------------------------------------------

interface PendingRequest {
  resolve: (value: any) => void
  reject: (reason: any) => void
  onChunk?: (chunk: ChunkInfo) => void
  onFrameBatch?: (batch: FrameBatchInfo) => void
  onAck?: (numFrames: number, totalChunks: number) => Promise<number>
  onStatus?: (status: {
    stage: string
    detail?: string
    elapsedSeconds?: number
    source: 'bridge'
  }) => void
  timeout?: NodeJS.Timeout
  kind?: 'ping' | 'init_avatar' | 'process_audio'
}

export type NativeSessionOwner = 'none' | 'preview' | 'live'

export interface YundingyunboServiceOptions {
  name?: string
  bridgeScriptBaseName?: string
  envOverrides?: Record<string, string>
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class YundingyunboService extends EventEmitter implements LipSyncBackend {
  readonly name: string
  private readonly bridgeScriptBaseName: string
  private readonly envOverrides: Record<string, string>

  private serverProcess: ChildProcess | null = null
  private serverReady = false
  private rl: Interface | null = null
  private expectedBridgeCloses = new WeakSet<ChildProcess>()
  private pendingRequests = new Map<string, PendingRequest>()
  private serverStarting: Promise<void> | null = null
  private bridgeGeneration = 0

  private runtimeResolved = false
  private yundingyunboBase = ''
  private yundingyunboPython = ''
  private bridgeScript = ''

  private currentAvatarPath: string | null = null
  private currentDrivingVideoPath: string | null = null
  private avatarInitialized = false
  private avatarFps = 25
  private avatarNFrames = 0
  private initializedCameraMode = false
  private initializedCameraIndex = -1
  private bridgeResetInProgress = false
  private sessionOwner: NativeSessionOwner = 'none'
  private liveTransitionPrepared = false
  private initAvatarGeneration = 0
  private initAvatarInFlight:
    | {
        key: string
        generation: number
        promise: Promise<void>
      }
    | null = null
  private activeInitAvatarRequestId: string | null = null

  // Camera mode state (set by live-room before initAvatar)
  private cameraMode = false
  private cameraIndex = -1
  private dshowVideoDeviceCache: string[] | null = null

  constructor(options: YundingyunboServiceOptions = {}) {
    super()
    this.name = (options.name || 'yundingyunbo').trim() || 'yundingyunbo'
    this.bridgeScriptBaseName =
      (options.bridgeScriptBaseName || DEFAULT_BRIDGE_SCRIPT).trim() || DEFAULT_BRIDGE_SCRIPT
    this.envOverrides = { ...(options.envOverrides || {}) }
  }

  // -----------------------------------------------------------------------
  // Path resolution
  // -----------------------------------------------------------------------

  private resolveRuntimePaths(): void {
    if (this.runtimeResolved) return

    this.yundingyunboBase = resolveYundingyunboBase()
    ensureYundingyunboRuntimeOverlay(this.yundingyunboBase)
    this.yundingyunboPython = resolveYundingyunboPython(this.yundingyunboBase)
    this.bridgeScript = findBridgeScript(this.bridgeScriptBaseName)

    const errors: string[] = []
    if (!existsSync(join(this.yundingyunboBase, 'live')))
      errors.push(`yundingyunbo base not valid (no live/ dir): ${this.yundingyunboBase}`)
    if (!existsSync(this.yundingyunboPython))
      errors.push(`yundingyunbo python not found: ${this.yundingyunboPython}`)
    if (!existsSync(this.bridgeScript))
      errors.push(`Bridge script not found: ${this.bridgeScript}`)
    if (errors.length > 0) throw new Error(errors.join('\n'))

    this.runtimeResolved = true
  }

  // -----------------------------------------------------------------------
  // Server lifecycle
  // -----------------------------------------------------------------------

  async startServer(): Promise<void> {
    if (this.serverProcess && this.serverReady) return
    if (this.serverStarting) {
      await this.serverStarting
      return
    }
    this.serverStarting = this._doStartServer()
    try {
      await this.serverStarting
    } finally {
      this.serverStarting = null
    }
  }

  private async _doStartServer(): Promise<void> {
    this.resolveRuntimePaths()
    this.bridgeResetInProgress = false
    const generation = ++this.bridgeGeneration

    const dataDir = getDataDir()
    const nodeDirs = getPortableNodeDirs(this.yundingyunboBase)
    const ffmpegDirs = getPortableFfmpegDirs(this.yundingyunboBase)
    const runtimePathExtras = [...nodeDirs, ...ffmpegDirs]
    const ffmpegExeCandidates = ffmpegDirs.map((dir) => join(dir, 'ffmpeg.exe'))
    const ffmpegExe = ffmpegExeCandidates.find((candidate) => existsSync(candidate)) || ''

    console.log(
      `[YDB] Starting ${this.name} bridge (${this.bridgeScriptBaseName}), base=${this.yundingyunboBase}`
    )
    console.log(`[YDB] Python=${this.yundingyunboPython}, script=${this.bridgeScript}`)
    if (runtimePathExtras.length > 0) {
      console.log(`[YDB] Runtime PATH extras: ${runtimePathExtras.join(' | ')}`)
    }

    const args = ['-u', this.bridgeScript]

    this.serverProcess = spawn(this.yundingyunboPython, args, {
      cwd: this.yundingyunboBase,
      windowsHide: true,
      env: {
        ...process.env,
        ...this.envOverrides,
        PATH: buildRuntimePath(runtimePathExtras, process.env.PATH || ''),
        PYTHONIOENCODING: 'utf-8',
        YUNDINGYUNBO_BASE: this.yundingyunboBase,
        XIYIJI_DATA_DIR: dataDir,
        XIYIJI_NODE_DIR: nodeDirs[0] || '',
        XIYIJI_FFMPEG_DIR: ffmpegDirs[0] || '',
        FFMPEG_BINARY: ffmpegExe || process.env.FFMPEG_BINARY || '',
        IMAGEIO_FFMPEG_EXE: ffmpegExe || process.env.IMAGEIO_FFMPEG_EXE || '',
        PYDUB_FFMPEG_PATH: ffmpegExe || process.env.PYDUB_FFMPEG_PATH || '',
      },
    })
    const proc = this.serverProcess
    const isCurrentBridge = () => this.serverProcess === proc && this.bridgeGeneration === generation

    if (!proc.stdout || !proc.stdin) {
      throw new Error('Failed to start yundingyunbo bridge: stdio not available')
    }

    proc.stdin.on('error', (err: any) => {
      if (!isCurrentBridge()) return
      const code = String(err?.code || '')
      if (code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED') {
        console.warn('[YDB] stdin pipe broken')
        this.handlePipeBroken()
        return
      }
      console.error('[YDB] stdin error:', err)
    })

    this.rl = createInterface({ input: proc.stdout })
    const rl = this.rl
    rl.on('line', (line) => {
      if (!isCurrentBridge()) return
      this.handleServerLine(line)
    })

    proc.stderr?.on('data', (data: Buffer) => {
      if (!isCurrentBridge()) return
      const text = data.toString().trim()
      if (text) {
        console.log(`[YDB-Bridge] ${text}`)
        this.handleBridgeRuntimeFailure(text)
      }
    })

    proc.on('close', (code) => {
      const expectedClose = this.expectedBridgeCloses.has(proc)
      if (expectedClose) {
        this.expectedBridgeCloses.delete(proc)
      }
      if (!isCurrentBridge()) {
        if (!expectedClose) {
          console.warn(`[YDB-Bridge] Stale process exited with code ${code}`)
        }
        return
      }
      console.warn(`[YDB-Bridge] Process exited with code ${code}`)
      this.serverReady = false
      if (this.serverProcess === proc) this.serverProcess = null
      if (this.rl === rl) this.rl = null
      this.avatarInitialized = false
      this.currentAvatarPath = null
      this.currentDrivingVideoPath = null
      this.initializedCameraMode = false
      this.initializedCameraIndex = -1
      this.initAvatarInFlight = null
      this.activeInitAvatarRequestId = null
      this.bridgeResetInProgress = false
      this.liveTransitionPrepared = false
      for (const [, req] of this.pendingRequests) {
        req.reject(new Error(`Bridge process terminated (code ${code})`))
      }
      this.pendingRequests.clear()
    })

    proc.on('error', (err) => {
      if (!isCurrentBridge()) return
      console.error(`[YDB-Bridge] Process error: ${err.message}`)
    })

    // Wait for ready
    await new Promise<void>((resolveReady, rejectReady) => {
      const timeout = setTimeout(() => {
        cleanup()
        if (!isCurrentBridge()) {
          rejectReady(new Error('Bridge startup superseded'))
          return
        }
        rejectReady(new Error(`Bridge startup timeout (${BRIDGE_START_TIMEOUT_MS / 1000}s)`))
      }, BRIDGE_START_TIMEOUT_MS)

      const onLine = (line: string) => {
        try {
          const msg = JSON.parse(line)
          if (msg.type === 'ready') {
            if (!isCurrentBridge()) {
              cleanup()
              rejectReady(new Error('Bridge startup superseded'))
              return
            }
            cleanup()
            this.serverReady = true
            console.log('[YDB] Bridge ready')
            resolveReady()
          }
        } catch {
          // Ignore non-JSON boot logs
        }
      }

      const onClose = (code: number | null) => {
        cleanup()
        if (!isCurrentBridge()) {
          rejectReady(new Error(`Bridge startup superseded (code ${code})`))
          return
        }
        rejectReady(new Error(`Bridge exited before ready (code ${code})`))
      }

      const cleanup = () => {
        clearTimeout(timeout)
        rl.removeListener('line', onLine)
        proc.removeListener('close', onClose)
      }

      rl.on('line', onLine)
      proc.once('close', onClose)
    })
  }

  private handlePipeBroken(): void {
    this.serverReady = false
    this.initAvatarInFlight = null
    this.activeInitAvatarRequestId = null
    for (const [, req] of this.pendingRequests) {
      try { req.reject(new Error('Bridge pipe closed')) } catch { /* */ }
    }
    this.pendingRequests.clear()
  }

  private handleBridgeRuntimeFailure(text: string): void {
    if (this.bridgeResetInProgress) return
    if (!/Error in render loop|GetWindowRect|cvDestroyWindow|NULL window/i.test(text)) return

    this.bridgeResetInProgress = true
    console.warn('[YDB] Native window failure detected, resetting bridge session')
    this.shutdown('native-window-failure')
  }

  private sendCommand(cmd: Record<string, any>): void {
    if (!this.serverProcess?.stdin?.writable) {
      throw new Error('Bridge not running')
    }
    const line = JSON.stringify(cmd)
    this.serverProcess.stdin.write(line + '\n')
  }

  private handleServerLine(line: string): void {
    let msg: any
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }

    const reqId = msg.id as string | undefined
    if (!reqId) return

    const pending = this.pendingRequests.get(reqId)
    if (!pending) return

    switch (msg.type) {
      case 'pong':
      case 'result':
        pending.resolve(msg)
        this.clearPending(reqId)
        break
      case 'ack':
        // For process_audio: ack means audio accepted, continue waiting for done
        if (pending.onAck) {
          pending.onAck(msg.num_frames || 0, msg.total_chunks || 1).catch(() => {})
        }
        break
      case 'status':
        if (pending.onStatus) {
          try {
            pending.onStatus({
              stage: String(msg.stage || '').trim(),
              detail: String(msg.detail || '').trim(),
              elapsedSeconds: Number(msg.elapsed || 0) || 0,
              source: 'bridge',
            })
          } catch {
            // ignore preview-status listener failures
          }
        }
        break
      case 'done':
        {
          const rawEndFrame = msg.end_frame
          const normalizedEndFrame =
            rawEndFrame !== null &&
            rawEndFrame !== undefined &&
            rawEndFrame !== '' &&
            Number.isFinite(Number(rawEndFrame))
              ? Number(rawEndFrame)
              : undefined
        pending.resolve({
          totalChunks: msg.total_chunks || 0,
          totalFrames: msg.total_frames || 0,
          endFrame: normalizedEndFrame,
        })
        this.clearPending(reqId)
        break
        }
      case 'error':
        pending.reject(new Error(msg.error || 'Unknown error'))
        this.clearPending(reqId)
        break
    }
  }

  private clearPending(reqId: string): void {
    const p = this.pendingRequests.get(reqId)
    if (p?.timeout) clearTimeout(p.timeout)
    this.pendingRequests.delete(reqId)
    if (this.activeInitAvatarRequestId === reqId) {
      this.activeInitAvatarRequestId = null
    }
  }

  private buildInitAvatarKey(videoPath: string, cameraMode: boolean, cameraIndex: number): string {
    const normalizedMode = cameraMode ? 'camera' : 'file'
    const normalizedCameraIndex = cameraMode ? cameraIndex : -1
    return `${videoPath}::${normalizedMode}::${normalizedCameraIndex}`
  }

  private emitInitAvatarStatus(status: {
    stage: string
    detail?: string
    elapsedSeconds?: number
    source: 'service' | 'bridge'
  }): void {
    try {
      this.emit('init-avatar-status', {
        ...status,
        cameraMode: this.cameraMode,
        at: Date.now(),
      })
    } catch (err: any) {
      console.warn(`[YDB] init-avatar-status listener failed: ${err?.message || err}`)
    }
  }

  private ensureInitAvatarStillCurrent(
    generation: number,
    requestKey: string,
    stage: string
  ): void {
    const current = this.initAvatarInFlight
    if (!current || current.generation !== generation || current.key !== requestKey) {
      throw new Error(`initAvatar superseded during ${stage}`)
    }
  }

  private cancelPendingInitAvatarRequest(reason: string): void {
    const reqId = this.activeInitAvatarRequestId
    if (!reqId) return

    const pending = this.pendingRequests.get(reqId)
    this.activeInitAvatarRequestId = null
    if (!pending) return

    if (pending.timeout) clearTimeout(pending.timeout)
    this.pendingRequests.delete(reqId)
    try {
      pending.reject(new Error(reason))
    } catch {
      // ignore double reject races
    }
  }

  // -----------------------------------------------------------------------
  // LipSyncBackend interface
  // -----------------------------------------------------------------------

  async submit(
    videoPath: string,
    audioPath: string,
    _instanceIdx?: number
  ): Promise<{ task_id: string }> {
    // Legacy batch mode: init avatar then process audio
    await this.initAvatar(videoPath)
    const taskId = uuidv4()
    // Fire and forget — process_audio via streaming path
    this.processAudioStream(audioPath).catch((err) => {
      console.error(`[YDB] Background process_audio failed: ${err.message}`)
    })
    return { task_id: taskId }
  }

  async query(
    _taskId: string,
    _instanceIdx?: number
  ): Promise<{ status: string; progress: number; result_path?: string; error?: string }> {
    // V2Manager renders internally, no result file
    return { status: 'completed', progress: 100 }
  }

  async probeInstances(): Promise<number[]> {
    try {
      await this.startServer()
      await this.pingServer()
      return [0]
    } catch (err: any) {
      console.warn(`[YDB] yundingyunbo unavailable: ${err.message}`)
      return []
    }
  }

  async isAvailable(): Promise<boolean> {
    const instances = await this.probeInstances()
    return instances.length > 0
  }

  getInstanceCount(): number {
    return 1
  }

  getStreamingTransport(): 'chunk' | 'frame_batch' {
    // V2Manager renders internally — no transport to our player
    return 'chunk'
  }

  hasActiveAppendStream(): boolean {
    return this.avatarInitialized
  }

  resetStreamingSession(): void {
    const hasBridgeActivity =
      !!this.serverProcess ||
      !!this.serverStarting ||
      this.serverReady ||
      this.pendingRequests.size > 0

    if (hasBridgeActivity) {
      this.shutdown('stream-reset', { force: true })
      return
    }

    this.avatarInitialized = false
    this.currentAvatarPath = null
    this.currentDrivingVideoPath = null
    this.initializedCameraMode = false
    this.initializedCameraIndex = -1
  }

  setSessionOwner(owner: NativeSessionOwner): void {
    if (owner === 'live' || owner === 'preview' || owner === 'none') {
      this.liveTransitionPrepared = false
    }
    if (this.sessionOwner === owner) return
    this.sessionOwner = owner
    console.log(`[YDB] Session owner -> ${owner}`)
  }

  clearSessionOwner(expectedOwner?: NativeSessionOwner): void {
    if (expectedOwner && this.sessionOwner !== expectedOwner) return
    this.setSessionOwner('none')
  }

  getSessionOwner(): NativeSessionOwner {
    return this.sessionOwner
  }

  prepareLiveTransition(): void {
    if (this.liveTransitionPrepared) return
    this.liveTransitionPrepared = true
    console.log('[YDB] Live transition prepared')
  }

  cancelPreparedLiveTransition(): void {
    if (!this.liveTransitionPrepared) return
    this.liveTransitionPrepared = false
    console.log('[YDB] Live transition preparation cleared')
  }

  getAvatarInfo(): { fps: number; nFrames: number } | null {
    if (!this.avatarInitialized) return null
    return { fps: this.avatarFps, nFrames: this.avatarNFrames }
  }

  async initAvatar(videoPath: string): Promise<void> {
    const inputPath = (videoPath || '').trim()
    if (!inputPath) {
      throw new Error('initAvatar requires a non-empty video path')
    }

    const requestedCameraMode = this.cameraMode
    const requestedCameraIndex = this.cameraIndex
    const requestKey = this.buildInitAvatarKey(
      inputPath,
      requestedCameraMode,
      requestedCameraIndex
    )

    if (this.initAvatarInFlight?.key === requestKey) {
      await this.initAvatarInFlight.promise
      return
    }

    this.cancelPendingInitAvatarRequest('initAvatar superseded by newer request')
    const generation = ++this.initAvatarGeneration

    const promise = Promise.resolve().then(async () => {
      this.emitInitAvatarStatus({
        stage: 'prepare_reference',
        detail: inputPath,
        source: 'service',
      })
      const preparedVideoPath = requestedCameraMode
        ? inputPath
        : (await prepareYdbAvatarVideo(inputPath)) || inputPath
      const { referenceVideoPath, drivingVideoPath } = resolveYdbAvatarInitPaths({
        inputPath,
        preparedVideoPath,
        cameraMode: requestedCameraMode,
      })
      console.log(
        `[YDB] initAvatar reference/driving selected: reference=${referenceVideoPath}, driving=${drivingVideoPath}, cameraMode=${requestedCameraMode}`
      )
      this.emitInitAvatarStatus({
        stage: 'reference_prepared',
        detail: referenceVideoPath,
        source: 'service',
      })
      this.ensureInitAvatarStillCurrent(generation, requestKey, 'reference selection')

      const sameAvatar = this.currentAvatarPath === referenceVideoPath
      const sameDrivingVideo = this.currentDrivingVideoPath === drivingVideoPath
      const sameMode = this.initializedCameraMode === requestedCameraMode
      const sameCamera =
        !requestedCameraMode || this.initializedCameraIndex === requestedCameraIndex
      if (this.avatarInitialized && sameAvatar && sameDrivingVideo && sameMode && sameCamera) {
        return
      }

      this.emitInitAvatarStatus({
        stage: 'starting_bridge',
        detail: this.yundingyunboBase || resolveYundingyunboBase(),
        source: 'service',
      })
      await this.startServer()
      this.emitInitAvatarStatus({
        stage: 'bridge_ready',
        detail: this.bridgeScript || findBridgeScript(this.bridgeScriptBaseName),
        source: 'service',
      })
      this.ensureInitAvatarStillCurrent(generation, requestKey, 'bridge startup')

      const reqId = uuidv4()
      this.activeInitAvatarRequestId = reqId
      const result = await new Promise<any>((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.clearPending(reqId)
          reject(new Error(`initAvatar timeout (${INIT_AVATAR_TIMEOUT_MS / 1000}s)`))
        }, INIT_AVATAR_TIMEOUT_MS)
        this.pendingRequests.set(reqId, {
          resolve,
          reject,
          onStatus: (status) => {
            this.emitInitAvatarStatus(status)
          },
          timeout,
          kind: 'init_avatar',
        })
        this.sendCommand({
          cmd: 'init_avatar',
          id: reqId,
          video: referenceVideoPath,
          driving_video: drivingVideoPath,
          camera_mode: requestedCameraMode,
          camera_index: requestedCameraIndex,
          init_generation: generation,
        })
      })

      this.ensureInitAvatarStillCurrent(generation, requestKey, 'bridge init result')
      this.avatarFps = result.fps || 25
      this.avatarNFrames = result.n_frames || 0
      this.currentAvatarPath = referenceVideoPath
      this.currentDrivingVideoPath = drivingVideoPath
      this.avatarInitialized = true
      this.initializedCameraMode = requestedCameraMode
      this.initializedCameraIndex = requestedCameraIndex
      if (referenceVideoPath !== inputPath) {
        console.log(
          `[YDB] Using prepared avatar reference clip: ${inputPath} -> ${referenceVideoPath}`
        )
      }
      if (!requestedCameraMode && referenceVideoPath !== drivingVideoPath) {
        console.log(
          `[YDB] Split avatar init: reference=${referenceVideoPath}, driving=${drivingVideoPath}`
        )
      }
      console.log(
        `[YDB] Avatar initialized: reference=${referenceVideoPath}, ` +
          `driving=${drivingVideoPath}, fps=${this.avatarFps}`
      )
    })

    this.initAvatarInFlight = {
      key: requestKey,
      generation,
      promise,
    }

    try {
      await promise
    } finally {
      if (this.initAvatarInFlight?.promise === promise) {
        this.initAvatarInFlight = null
      }
    }
  }

  /**
   * Replace the short (~180s) normalized_video.mp4 inside every matching
   * character cache directory with a version scaled from the full driving
   * video.  This runs ffmpeg in the Electron main process (no CUDA
   * contention with the bridge's TensorRT) and only triggers when the
   * driving video is significantly longer than the existing file.
   */

  async processAudioStream(
    audioPath: string,
    onChunk?: (chunk: ChunkInfo) => void,
    onAck?: (numFrames: number, totalChunks: number) => Promise<number>,
    _onFrameBatch?: (batch: FrameBatchInfo) => void
  ): Promise<{ totalChunks: number; totalFrames: number; endFrame?: number }> {
    await this.startServer()

    const reqId = uuidv4()
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.clearPending(reqId)
        reject(new Error(`processAudioStream timeout`))
      }, PROCESS_AUDIO_TIMEOUT_MS)

      this.pendingRequests.set(reqId, {
        resolve,
        reject,
        onChunk,
        onAck,
        timeout,
        kind: 'process_audio',
      })
      this.sendCommand({
        cmd: 'process_audio',
        id: reqId,
        audio: audioPath,
      })
    })
  }

  shutdown(reason: string = 'manual', opts?: { force?: boolean }): void {
    if (
      !opts?.force &&
      reason === 'player-close' &&
      (this.sessionOwner === 'live' || this.liveTransitionPrepared)
    ) {
      console.log('[YDB] Ignored player-close because live startup/session owns the native renderer')
      return
    }

    console.log(`[YDB] shutdown: reason=${reason}, force=${!!opts?.force}, sessionOwner=${this.sessionOwner}, avatarInitialized=${this.avatarInitialized}, hasBridge=${!!this.serverProcess}`)

    const proc = this.serverProcess
    const rl = this.rl
    const force = !!opts?.force
    this.bridgeGeneration += 1

    if (proc) {
      this.expectedBridgeCloses.add(proc)
    }

    if (proc?.stdin?.writable) {
      try {
        proc.stdin.write(JSON.stringify({ cmd: 'shutdown', id: uuidv4() }) + '\n')
      } catch {
        // ignore broken pipe during shutdown
      }
    }

    this.serverProcess = null
    this.rl = null
    this.serverReady = false
    this.serverStarting = null
    this.avatarInitialized = false
    this.currentAvatarPath = null
    this.currentDrivingVideoPath = null
    this.initializedCameraMode = false
    this.initializedCameraIndex = -1
    this.initAvatarInFlight = null
    this.activeInitAvatarRequestId = null
    this.liveTransitionPrepared = false
    this.sessionOwner = 'none'
    for (const [, req] of this.pendingRequests) {
      if (req.timeout) clearTimeout(req.timeout)
      try { req.reject(new Error(`Bridge shutdown: ${reason}`)) } catch { /* */ }
    }
    this.pendingRequests.clear()
    this.bridgeResetInProgress = false

    try { rl?.close() } catch { /* */ }

    if (proc) {
      setTimeout(() => {
        try {
          if (!proc.killed) proc.kill()
        } catch {
          // ignore double-kill races
        }
      }, force ? 200 : 1500)
    }
  }

  // Camera frame methods — V2Manager handles camera natively, no injection needed.
  setCameraFramePath(_path: string): void { /* no-op */ }
  clearCameraFrame(): void { /* no-op */ }
  injectCameraFrame(_jpegBase64: string): void { /* no-op */ }

  /**
   * Configure camera mode for V2Manager.
   * Call BEFORE initAvatar to enable native camera capture.
   */
  setCameraModeEnabled(enabled: boolean, camIndex: number = 0): void {
    this.cameraMode = enabled
    this.cameraIndex = camIndex
    console.log(`[YDB] Camera mode: ${enabled ? 'ON' : 'OFF'}, index=${camIndex}`)
  }

  async resolveCameraIndex(
    cameraDeviceId?: string | null,
    cameraDeviceLabel?: string | null
  ): Promise<number> {
    const deviceNames = await this.listDirectShowVideoDevices()
    const label = (cameraDeviceLabel || '').trim()

    if (label) {
      const exact = this.findCameraIndexByName(deviceNames, label)
      if (exact >= 0) {
        console.log(`[YDB] Resolved camera label "${label}" -> index ${exact}`)
        return exact
      }
      console.warn(`[YDB] Failed to resolve camera label "${label}", falling back`)
    }

    const legacy = (cameraDeviceId || '').trim()
    const directIndex = Number.parseInt(legacy, 10)
    if (!Number.isNaN(directIndex) && directIndex >= 0) {
      if (deviceNames.length === 0) {
        if (directIndex <= 9) {
          console.warn(`[YDB] Camera enumeration unavailable, using small numeric index ${directIndex}`)
          return directIndex
        }
      } else if (directIndex < deviceNames.length) {
        console.log(`[YDB] Using numeric DirectShow camera index: ${directIndex}`)
        return directIndex
      } else {
        console.warn(
          `[YDB] Ignoring numeric camera device id "${legacy}" because DirectShow indices are 0-${deviceNames.length - 1}`
        )
      }
    }

    if (legacy) {
      const legacyMatch = this.findCameraIndexByName(deviceNames, legacy)
      if (legacyMatch >= 0) {
        console.log(`[YDB] Resolved legacy camera id "${legacy}" -> index ${legacyMatch}`)
        return legacyMatch
      }
    }

    console.warn(
      `[YDB] Falling back to camera index 0 (deviceId=${cameraDeviceId || ''}, label=${cameraDeviceLabel || ''})`
    )
    return 0
  }

  private async listDirectShowVideoDevices(): Promise<string[]> {
    if (this.dshowVideoDeviceCache) return this.dshowVideoDeviceCache

    this.resolveRuntimePaths()
    const ffmpegPath = join(this.yundingyunboBase, 'env', 'ffmpeg', 'bin', 'ffmpeg.exe')
    if (!existsSync(ffmpegPath)) {
      console.warn(`[YDB] ffmpeg not found for camera enumeration: ${ffmpegPath}`)
      return []
    }

    let text = ''
    try {
      const result = await execFileAsync(
        ffmpegPath,
        ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'],
        {
          windowsHide: true,
          timeout: 10_000,
          encoding: 'utf8',
          maxBuffer: 1024 * 1024,
        }
      )
      text = `${result.stdout || ''}\n${result.stderr || ''}`
    } catch (err: any) {
      text = `${err?.stdout || ''}\n${err?.stderr || ''}`
      if (!text) {
        console.warn(`[YDB] Camera enumeration failed: ${err?.message || err}`)
        return []
      }
    }

    const devices: string[] = []
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line.includes('(video)')) continue
      const match = line.match(/"(.+)"\s+\(video\)$/)
      if (!match) continue
      const name = match[1].trim()
      if (!name || devices.includes(name)) continue
      devices.push(name)
    }

    this.dshowVideoDeviceCache = devices
    if (devices.length > 0) {
      console.log(`[YDB] DirectShow cameras: ${devices.map((name, idx) => `${idx}:${name}`).join(', ')}`)
    } else {
      console.warn('[YDB] No DirectShow video devices found during enumeration')
    }
    return devices
  }

  private findCameraIndexByName(deviceNames: string[], expectedName: string): number {
    const normalizedExpected = this.normalizeDeviceName(expectedName)
    if (!normalizedExpected) return -1

    for (let i = 0; i < deviceNames.length; i += 1) {
      if (this.normalizeDeviceName(deviceNames[i]) === normalizedExpected) return i
    }

    for (let i = 0; i < deviceNames.length; i += 1) {
      const normalizedDevice = this.normalizeDeviceName(deviceNames[i])
      if (
        normalizedDevice.includes(normalizedExpected) ||
        normalizedExpected.includes(normalizedDevice)
      ) {
        return i
      }
    }

    return -1
  }

  private normalizeDeviceName(name: string): string {
    return name
      .toLowerCase()
      .replace(/\([^)]*\)/g, ' ')
      .replace(/\[[^\]]*\]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private async pingServer(): Promise<void> {
    const reqId = uuidv4()
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.clearPending(reqId)
        reject(new Error(`Ping timeout`))
      }, PING_TIMEOUT_MS)
      this.pendingRequests.set(reqId, {
        resolve: () => { resolve() },
        reject,
        timeout,
        kind: 'ping',
      })
      this.sendCommand({ cmd: 'ping', id: reqId })
    })
  }
}

export const yundingyunboService = new YundingyunboService()
