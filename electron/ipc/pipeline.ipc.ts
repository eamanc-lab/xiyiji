import { ipcMain, BrowserWindow, app } from 'electron'
import { pipelineService, PipelineTask, TaskSource } from '../services/pipeline.service'
import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { v4 as uuidv4 } from 'uuid'
import { setActiveBackend, getBackend, getRegisteredBackends, BackendType } from '../services/lipsync-backend'
import { setConfig } from '../config'

/**
 * Get the player window by iterating all windows.
 * The player window has a preload script ending in 'player.js'.
 */
function getPlayerWindow(): BrowserWindow | null {
  const wins = BrowserWindow.getAllWindows()
  for (const w of wins) {
    if (w.isDestroyed()) continue
    const url = w.webContents.getURL()
    if (url.includes('player.html')) return w
  }
  return null
}

/**
 * Get the main renderer window (first window that's not the player).
 */
function getMainWindow(): BrowserWindow | null {
  const wins = BrowserWindow.getAllWindows()
  for (const w of wins) {
    if (w.isDestroyed()) continue
    const url = w.webContents.getURL()
    if (!url.includes('player.html')) return w
  }
  return null
}

/**
 * Send event to main renderer window.
 */
function sendToRenderer(channel: string, ...args: any[]): void {
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, ...args)
  }
}

/**
 * Send result video to player window for playback.
 */
function sendToPlayer(videoPath: string): void {
  const player = getPlayerWindow()
  if (player && !player.isDestroyed()) {
    player.webContents.send('player:play-result', videoPath)
  }
}

export function registerPipelineIpc(): void {
  const strictTestFlow = (process.env.DIANJT_STRICT_TEST_FLOW || '1').trim() !== '0'
  // Set avatar video for F2F
  ipcMain.handle('pipeline:set-avatar', (_event, videoPath: string) => {
    try {
      pipelineService.setAvatarVideo(videoPath)
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // Submit audio file for F2F processing
  ipcMain.handle(
    'pipeline:submit-audio',
    (_event, audioPath: string, source: TaskSource, text?: string) => {
      try {
        const task = pipelineService.enqueue(audioPath, source, text)
        return { success: true, taskId: task.id }
      } catch (err: any) {
        return { success: false, error: err.message }
      }
    }
  )

  // TTS + F2F one-shot
  ipcMain.handle(
    'pipeline:submit-tts',
    async (_event, text: string, voice: string, speed: number) => {
      try {
        const task = await pipelineService.enqueueTts(text, voice, speed, 'tts')
        return { success: true, taskId: task.id }
      } catch (err: any) {
        return { success: false, error: err.message }
      }
    }
  )

  // Save mic recording and submit to F2F
  ipcMain.handle(
    'pipeline:submit-mic',
    async (_event, audioBuffer: ArrayBuffer) => {
      try {
        // Save to face2face/audio/ so Docker container can access it
        const dataDir = require('../config').getDataDir()
        const micDir = join(dataDir, 'face2face', 'audio')
        if (!existsSync(micDir)) mkdirSync(micDir, { recursive: true })
        const audioPath = join(micDir, `mic_${uuidv4()}.wav`)
        writeFileSync(audioPath, Buffer.from(audioBuffer))
        console.log(`[Pipeline] Mic audio saved: ${audioPath} (${audioBuffer.byteLength} bytes)`)
        const task = pipelineService.enqueue(audioPath, 'manual', '麦克风录音')
        return { success: true, taskId: task.id }
      } catch (err: any) {
        return { success: false, error: err.message }
      }
    }
  )

  // Cancel task(s)
  ipcMain.handle('pipeline:cancel', (_event, taskId?: string) => {
    pipelineService.cancel(taskId)
    return { success: true }
  })

  // Get pipeline status
  ipcMain.handle('pipeline:status', () => {
    return pipelineService.getStatus()
  })

  // Forward pipeline events to renderer
  pipelineService.on('task:status-change', (task: PipelineTask) => {
    sendToRenderer('pipeline:task-update', serializeTask(task))
  })

  pipelineService.on('task:completed', (task: PipelineTask) => {
    sendToRenderer('pipeline:task-completed', serializeTask(task))
    // In streaming mode, chunks were already sent to player individually.
    // Only send full result in legacy (non-streaming) mode.
    if (task.resultVideoPath && !task.isStreaming) {
      sendToPlayer(task.resultVideoPath)
    }
    if (!strictTestFlow && task.isStreaming && task.streamTransport === 'frame_batch') {
      const player = getPlayerWindow()
      if (player && !player.isDestroyed()) {
        player.webContents.send('player:frame-stream-done')
      }
    }
  })

  // Chunk generation progress: forward chunks to player and notify renderer
  pipelineService.on(
    'task:chunk-ready',
    (
      task: PipelineTask,
      videoPath: string,
      chunkIndex: number,
      totalChunks: number,
      streamAudioPath?: string,
      chunkFrames?: number
    ) => {
      if (strictTestFlow) return
      // Skip chunks from cancelled tasks — F2F server may still be generating after cancelAll()
      if (task.status === 'failed') return

      sendToRenderer('pipeline:chunk-ready', serializeTask(task), chunkIndex, totalChunks)

      // In streaming mode, send each chunk directly to the player for immediate playback
      // unless the task is using frame-batch transport.
      if (task.isStreaming && task.streamTransport !== 'frame_batch') {
        const player = getPlayerWindow()
        if (player && !player.isDestroyed()) {
          player.webContents.send(
            'player:play-chunk',
            videoPath,
            streamAudioPath || null,
            typeof chunkFrames === 'number' ? chunkFrames : null
          )
        }
      }
    }
  )

  // ---------------------------------------------------------------------------
  // Frame-batch coalescing: accumulate small 2-frame batches from the backend
  // and forward them to the renderer as larger ~30-frame mega-batches.  This
  // reduces IPC message count from ~300 to ~20 per segment, avoiding the
  // Chromium IPC pipe congestion that limits throughput to ~26 fps.
  // ---------------------------------------------------------------------------
  const COALESCE_MAX_FRAMES = 30       // flush after this many frames
  const COALESCE_MAX_WAIT_MS = 50      // flush at least every 50ms
  const COALESCE_FIRST_FLUSH = 4       // flush the very first batch quickly (preroll)
  let coalesceBuf: { frames: string[]; frameIndices: number[] } = { frames: [], frameIndices: [] }
  let coalesceMeta: any = null          // batch metadata (fps, width, height, etc.)
  let coalesceTimer: ReturnType<typeof setTimeout> | null = null
  let coalesceFirstFlushed = false

  function flushCoalesced(): void {
    if (coalesceTimer) { clearTimeout(coalesceTimer); coalesceTimer = null }
    if (coalesceBuf.frames.length === 0) return
    const player = getPlayerWindow()
    if (!player || player.isDestroyed()) {
      coalesceBuf = { frames: [], frameIndices: [] }
      coalesceMeta = null
      return
    }
    const merged = {
      ...coalesceMeta,
      frames: coalesceBuf.frames,
      frameIndices: coalesceBuf.frameIndices
    }
    coalesceBuf = { frames: [], frameIndices: [] }
    coalesceMeta = null
    player.webContents.send('player:play-frame-batch', merged)
  }

  // Frame-batch generation progress: forward to player in frame transport mode.
  pipelineService.on('task:frame-batch-ready', (task: PipelineTask, batch: any) => {
    if (task.status === 'failed') return
    if (!task.isStreaming || task.streamTransport !== 'frame_batch') {
      if (strictTestFlow) {
        console.warn(
          `[Pipeline IPC][STRICT] Ignored non-frame_batch frame event: task=${task.id}, transport=${task.streamTransport}`
        )
      }
      return
    }
    if (!batch) return

    // Preserve first batch's metadata (audioPath, fps, dims, totalFrames, appendStream).
    if (!coalesceMeta) {
      coalesceMeta = { ...batch, frames: [], frameIndices: [] }
      coalesceFirstFlushed = false
    }
    // If incoming batch carries a NEW audioPath, flush the previous accumulation
    // first so the player sees the audio boundary at the right frame boundary.
    const prevAudio = coalesceMeta.audioPath || ''
    const newAudio = batch.audioPath || ''
    if (newAudio && newAudio !== prevAudio && coalesceBuf.frames.length > 0) {
      flushCoalesced()
      coalesceMeta = { ...batch, frames: [], frameIndices: [] }
      coalesceFirstFlushed = false
    }

    // Append frames into the coalesce buffer.
    const batchFrames = Array.isArray(batch.frames) ? batch.frames : []
    const batchIndices = Array.isArray(batch.frameIndices) ? batch.frameIndices : []
    const n = Math.min(batchFrames.length, batchIndices.length)
    for (let i = 0; i < n; i++) {
      coalesceBuf.frames.push(batchFrames[i])
      coalesceBuf.frameIndices.push(batchIndices[i])
    }
    // Propagate totalFrames from any batch that carries it.
    if (typeof batch.totalFrames === 'number' && batch.totalFrames > 0) {
      coalesceMeta.totalFrames = batch.totalFrames
    }

    // Flush immediately for the very first few frames (preroll / first-frame latency).
    const flushThreshold = coalesceFirstFlushed ? COALESCE_MAX_FRAMES : COALESCE_FIRST_FLUSH
    if (coalesceBuf.frames.length >= flushThreshold) {
      coalesceFirstFlushed = true
      flushCoalesced()
      return
    }

    // Schedule a timer-based flush so frames don't sit too long.
    if (!coalesceTimer) {
      coalesceTimer = setTimeout(() => {
        coalesceTimer = null
        coalesceFirstFlushed = true
        flushCoalesced()
      }, COALESCE_MAX_WAIT_MS)
    }
  })

  pipelineService.on('task:failed', (task: PipelineTask) => {
    flushCoalesced() // drain any pending frames before signalling failure
    sendToRenderer('pipeline:task-failed', serializeTask(task))
    if (!strictTestFlow && task.isStreaming && task.streamTransport === 'frame_batch') {
      const player = getPlayerWindow()
      if (player && !player.isDestroyed()) {
        player.webContents.send('player:frame-stream-done')
      }
    }
  })

  pipelineService.on('pipeline:idle', () => {
    sendToRenderer('pipeline:idle')
  })

  pipelineService.on('pipeline:busy', () => {
    sendToRenderer('pipeline:busy')
  })

  // Player notifies result playback finished
  ipcMain.on('player:result-finished', () => {
    sendToRenderer('pipeline:playback-finished')
  })

  // Switch lip-sync backend
  ipcMain.handle('pipeline:set-backend', (_event, backend: string) => {
    try {
      const requested = String(backend || '').trim() as BackendType
      if (!getBackend(requested)) {
        console.warn(`[Pipeline IPC] Unsupported backend '${backend}', forcing yundingyunbo`)
        setActiveBackend('yundingyunbo')
        setConfig('lipsync_backend', 'yundingyunbo')
        return { success: true, backend: 'yundingyunbo' }
      }
      setActiveBackend(requested)
      setConfig('lipsync_backend', requested)
      return { success: true, backend: requested }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // Check if a backend is available
  ipcMain.handle('pipeline:check-backend', async (_event, backend: string) => {
    try {
      const requested = String(backend || '').trim() as BackendType
      if (!requested) {
        return { available: false }
      }
      const b = getBackend(requested)
      if (!b) return { available: false }
      return { available: await b.isAvailable() }
    } catch {
      return { available: false }
    }
  })

  // List registered backends
  ipcMain.handle('pipeline:list-backends', () => {
    return getRegisteredBackends()
  })
}

function serializeTask(task: PipelineTask) {
  return {
    id: task.id,
    source: task.source,
    sourceText: task.sourceText,
    status: task.status,
    progress: task.progress,
    resultVideoPath: task.resultVideoPath,
    error: task.error,
    createdAt: task.createdAt,
    isStreaming: task.isStreaming,
    streamTransport: task.streamTransport
  }
}
