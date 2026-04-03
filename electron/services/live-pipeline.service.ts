import { ipcMain } from 'electron'
import { queueManager, PlaylistItem } from './queue.manager'
import { pipelineService, PipelineTask } from './pipeline.service'
import { getMainWindow } from '../../src/main/index'
import { getPlayerStreamQueueState } from '../ipc/player.ipc'
import { getActiveBackendType, isNativeRendererBackendType } from './lipsync-backend'

/**
 * LivePipelineService — the SOLE bridge between QueueManager and PipelineService
 * during live broadcast.
 *
 * Design principles:
 * 1. Only ONE queue item is submitted to the pipeline at a time.
 * 2. We track the pipeline task ID to match completions to our submissions.
 * 3. We advance the queue on task:completed / task:failed (not player:result-finished).
 *    This allows continuous streaming: the next item is submitted to the pipeline
 *    immediately when F2F processing finishes, while the player is still playing
 *    the previous item's chunks. The player handles chunk queuing seamlessly.
 * 4. Queue status tracks TWO phases: 'playing' = F2F processing, 'buffered' = audio
 *    in player. The buffered→done transition is driven by CHUNK COUNTING from the
 *    player: each time a video chunk finishes playing, the player sends a
 *    'player:chunk-played' IPC event. When the count reaches totalChunks for an
 *    item, it's marked 'done'. This is perfectly accurate — no timer drift.
 * 5. All queue state changes are pushed to the renderer via IPC.
 */
class LivePipelineService {
  private isRunning = false
  private activeRoomId: string | null = null
  private readonly strictTestFlow = (process.env.DIANJT_STRICT_TEST_FLOW || '1').trim() !== '0'
  private readonly maxBufferedChunks = (() => {
    const raw = Number(process.env.LIVE_MAX_BUFFERED_CHUNKS || '4')
    if (!Number.isFinite(raw)) return 4
    return Math.max(0, Math.min(200, Math.floor(raw)))
  })()
  private readonly maxBufferedFrameSegments = (() => {
    const raw = Number(process.env.LIVE_MAX_BUFFERED_FRAME_SEGMENTS || '6')
    if (!Number.isFinite(raw)) return 6
    return Math.max(1, Math.min(24, Math.floor(raw)))
  })()
  private lastBackpressureLogAt = 0

  // ── Processing state ──────────────────────────────────────────────
  private isProcessing = false
  private currentQueueItemId: string | null = null      // which queue item
  private currentPipelineTaskId: string | null = null    // which pipeline task

  // ── Buffered→done chunk tracking ───────────────────────────────────
  // When F2F finishes, the item moves to 'buffered' (its chunks are in the player).
  // The player sends 'player:chunk-played' each time a chunk video finishes playing.
  // Items are tracked in a FIFO queue: the head item counts received chunk events
  // until it reaches totalChunks, then it's marked 'done' and the next item becomes
  // the head. This is perfectly accurate — driven by actual playback, not timers.
  //
  // Edge case: chunks may finish playing BEFORE scheduleBufferedDone is called
  // (F2F is faster than the pipeline event loop). These are tracked in
  // unassignedChunksPlayed and applied when the item is registered.
  //
  // chunkDirPath: stored so we can delete chunk files immediately when all are played,
  // instead of relying on the 60-second timer in PipelineService (which can fire while
  // chunks are still queued in the player when the queue grows large).
  private chunkTrackingQueue: Array<{ itemId: string; totalChunks: number; played: number; chunkDirPath?: string }> = []
  private unassignedChunksPlayed: number = 0
  private frameSegmentTrackingQueue: string[] = []
  private unassignedFrameAudioEnded = 0

  // ── Event handlers (bound for proper cleanup) ─────────────────────

  private readonly onQueueChanged = (_queue: PlaylistItem[]): void => {
    this.pushQueueToRenderer()
    this.tryProcessNext()
  }

  /**
   * Pipeline task completed (F2F finished, chunks sent to player).
   * If it matches our tracked task, transition playing→buffered and advance.
   */
  private readonly onTaskCompleted = (task: PipelineTask): void => {
    if (!this.isRunning) return
    if (task.id !== this.currentPipelineTaskId) return  // not our task

    console.log(`[LivePipeline] Task completed: ${task.sourceText?.slice(0, 40)} (audio=${task.audioDuration?.toFixed(1)}s)`)
    this.advanceQueue(task)
  }

  /**
   * Pipeline task failed (Docker error, GPU error, missing file, etc.).
   * If it matches our tracked task, skip and advance.
   */
  private readonly onTaskFailed = (task: PipelineTask): void => {
    if (!this.isRunning) return
    if (task.id !== this.currentPipelineTaskId) return  // not our task

    console.warn(`[LivePipeline] Task failed: ${task.error || 'unknown'}, skipping`)
    this.advanceQueue(task)
  }

  /**
   * Player finished playing a video chunk.
   * Increment the counter for the head item; mark done when all chunks played.
   */
  private readonly onChunkPlayed = (): void => {
    if (!this.isRunning) return
    if (this.strictTestFlow) return

    if (this.chunkTrackingQueue.length === 0) {
      // No item registered yet — buffer the count
      this.unassignedChunksPlayed++
      this.tryProcessNext()
      return
    }

    const head = this.chunkTrackingQueue[0]
    head.played++

    if (head.played >= head.totalChunks) {
      // This item is fully played
      const { chunkDirPath } = head
      this.chunkTrackingQueue.shift()
      queueManager.markDoneById(head.itemId)
      this.pushQueueToRenderer()
      console.log(`[LivePipeline] Chunk tracking: "${head.itemId.slice(0, 8)}" done (${head.played}/${head.totalChunks}), remaining=${this.chunkTrackingQueue.length}`)

      // Delete chunk files now that the player has confirmed playing all of them.
      // This replaces the 60-second timer in PipelineService, which fires too early
      // when the player's chunk queue grows large (100+ items).
      if (chunkDirPath) pipelineService.cleanupChunkDir(chunkDirPath)

      // Check if next item already has enough pre-played chunks (unlikely but safe)
      this.drainCompletedItems()
    }
    this.tryProcessNext()
  }

  /**
   * Frame-stream append mode: one sentence is complete when its audio segment ends.
   * This aligns live queue progression with actual playback instead of backend ACK timing.
   */
  private readonly onFrameAudioEnded = (_event: any, audioPath?: string): void => {
    if (!this.isRunning) return
    if (!this.strictTestFlow) return

    if (this.frameSegmentTrackingQueue.length === 0) {
      this.unassignedFrameAudioEnded++
      this.tryProcessNext()
      return
    }

    const itemId = this.frameSegmentTrackingQueue.shift()!
    queueManager.markDoneById(itemId)
    this.pushQueueToRenderer()
    console.log(
      `[LivePipeline] Frame tracking: "${itemId.slice(0, 8)}" done (audio-ended, remain=${this.frameSegmentTrackingQueue.length}, audio=${(audioPath || '').slice(-48)})`
    )
    this.tryProcessNext()
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  start(roomId: string): void {
    if (this.isRunning) return
    this.isRunning = true
    this.activeRoomId = roomId
    this.isProcessing = false
    this.currentQueueItemId = null
    this.currentPipelineTaskId = null
    this.clearChunkTracking()

    queueManager.on('changed', this.onQueueChanged)
    pipelineService.on('task:completed', this.onTaskCompleted)
    pipelineService.on('task:failed', this.onTaskFailed)
    ipcMain.on('player:chunk-played', this.onChunkPlayed)
    ipcMain.on('player:frame-audio-ended', this.onFrameAudioEnded)

    console.log('[LivePipeline] Started')
  }

  stop(): void {
    if (!this.isRunning) return
    this.isRunning = false
    this.activeRoomId = null
    this.isProcessing = false
    this.currentQueueItemId = null
    this.currentPipelineTaskId = null

    // Clean up chunk tracking and mark remaining buffered as done
    this.clearChunkTracking()
    queueManager.markAllBufferedDone()

    queueManager.removeListener('changed', this.onQueueChanged)
    pipelineService.removeListener('task:completed', this.onTaskCompleted)
    pipelineService.removeListener('task:failed', this.onTaskFailed)
    ipcMain.removeListener('player:chunk-played', this.onChunkPlayed)
    ipcMain.removeListener('player:frame-audio-ended', this.onFrameAudioEnded)

    console.log('[LivePipeline] Stopped')
  }

  // ── Skip / Clear (called by IPC handlers) ────────────────────────

  /**
   * Skip the currently audible item.
   * Drops all buffered items and the processing item,
   * cancels in-flight F2F, and starts the next item.
   */
  skipCurrent(): void {
    // Clear chunk tracking and drop all buffered items
    this.clearChunkTracking()
    queueManager.dropAllBuffered()

    if (!this.isRunning || !this.isProcessing) {
      // Nothing being processed — also skip any playing item in the queue
      queueManager.skipCurrent()
      return
    }

    // Cancel the pipeline task (stops F2F from generating more chunks)
    if (this.currentPipelineTaskId) {
      pipelineService.cancel(this.currentPipelineTaskId)
    }

    // Mark the processing queue item as dropped
    queueManager.skipCurrent()

    // Reset and immediately process next
    this.currentQueueItemId = null
    this.currentPipelineTaskId = null
    this.isProcessing = false
    this.tryProcessNext()
  }

  /**
   * Clear all items and cancel the current F2F task.
   */
  clearQueue(): void {
    this.clearChunkTracking()

    if (this.currentPipelineTaskId) {
      pipelineService.cancel(this.currentPipelineTaskId)
    }

    queueManager.dropAllBuffered()   // drop items being heard
    queueManager.skipCurrent()       // drop the item being processed
    queueManager.clearPending()      // drop all pending/ready items

    this.currentQueueItemId = null
    this.currentPipelineTaskId = null
    this.isProcessing = false
  }

  // ── Core processing loop ──────────────────────────────────────────

  private tryProcessNext(): void {
    if (!this.isRunning) return
    if (this.isProcessing) return
    if (this.strictTestFlow) {
      const now = Date.now()
      const q = getPlayerStreamQueueState()
      const fresh = q.updatedAt > 0 && now - q.updatedAt <= 5000
      const inFrameStream = q.mode === 'frame-streaming'
      const depth = fresh && inFrameStream ? q.depth : 0
      const pendingFrameSegments = this.frameSegmentTrackingQueue.length
      if (pendingFrameSegments >= this.maxBufferedFrameSegments) {
        if (now - this.lastBackpressureLogAt >= 1000) {
          this.lastBackpressureLogAt = now
          console.log(
            `[LivePipeline] Backpressure hold(frame-segment): pending=${pendingFrameSegments}, max=${this.maxBufferedFrameSegments}`
          )
        }
        return
      }
      if (depth >= this.maxBufferedFrameSegments) {
        if (now - this.lastBackpressureLogAt >= 1000) {
          this.lastBackpressureLogAt = now
          console.log(
            `[LivePipeline] Backpressure hold(frame): depth=${depth}, max=${this.maxBufferedFrameSegments}`
          )
        }
        return
      }
    }
    const bufferedChunks = this.getBufferedChunkBacklog()
    if (!this.strictTestFlow && bufferedChunks >= this.maxBufferedChunks) {
      const now = Date.now()
      if (now - this.lastBackpressureLogAt >= 1000) {
        this.lastBackpressureLogAt = now
        console.log(
          `[LivePipeline] Backpressure hold: bufferedChunks=${bufferedChunks}, max=${this.maxBufferedChunks}`
        )
      }
      return
    }

    // IMPORTANT: set isProcessing BEFORE calling next().
    // next() synchronously emits 'changed' via EventEmitter, which re-enters
    // this method through onQueueChanged. Without this guard, every ready item
    // would cascade into 'playing' status in one synchronous call.
    this.isProcessing = true

    const item = queueManager.next()
    if (!item) {
      this.isProcessing = false
      return
    }

    this.currentQueueItemId = item.id
    this.submitToPipeline(item)
  }

  private submitToPipeline(item: PlaylistItem): void {
    if (!item.audioPath) {
      console.warn('[LivePipeline] Item has no audio path, skipping:', item.id)
      this.advanceQueue()
      return
    }

    try {
      const sourceMap: Record<string, any> = { ai: 'tts', shortcut: 'manual', manual: 'manual' }
      const source = sourceMap[item.source] || 'tts'

      const pipelineTask = pipelineService.enqueue(item.audioPath, source, item.text)
      this.currentPipelineTaskId = pipelineTask.id

      console.log(`[LivePipeline] Submitted to pipeline: "${item.text.slice(0, 40)}" (queue=${item.id}, pipeline=${pipelineTask.id})`)
    } catch (err: any) {
      console.error('[LivePipeline] Pipeline enqueue failed:', err.message)
      this.advanceQueue()
    }
  }

  /**
   * Advance the queue when a pipeline task finishes.
   *
   * Status flow: playing → buffered → done (chunk counting)
   *
   * When F2F finishes, the item's video chunks are now in the player. We:
   * 1. Transition playing → buffered
   * 2. Register the item for chunk counting (player sends 'player:chunk-played'
   *    each time a chunk finishes; when count reaches totalChunks → 'done')
   * 3. Pick up the next ready item for F2F processing
   */
  private advanceQueue(completedTask?: PipelineTask): void {
    // Capture the current item info before transitioning
    const playing = queueManager.getCurrentlyPlaying()
    const isYundingyunbo = isNativeRendererBackendType(getActiveBackendType())

    if (isYundingyunbo) {
      queueManager.markCurrentDone()
      if (playing) {
        console.log(`[LivePipeline] YDB native playback complete: "${playing.text.slice(0, 40)}"`)
      }
    } else {
      queueManager.markCurrentBuffered()
      if (playing) {
        this.scheduleBufferedDone(playing.id, completedTask)
      }
    }

    this.currentQueueItemId = null
    this.currentPipelineTaskId = null
    this.isProcessing = false
    this.tryProcessNext()
  }

  // ── Buffered→done chunk tracking ─────────────────────────────────

  /**
   * Register a buffered item for chunk-based done tracking.
   *
   * The player sends 'player:chunk-played' each time a video chunk finishes.
   * Chunks arrive in strict FIFO order (pipeline processes one item at a time,
   * player plays chunks in order). So we track items in a FIFO queue and count
   * chunk events against the head item.
   *
   * If totalChunks is unknown (failed task, no streaming), mark done immediately.
   */
  private scheduleBufferedDone(itemId: string, task?: PipelineTask): void {
    if (this.strictTestFlow && task?.streamTransport === 'frame_batch') {
      if (task.status !== 'completed') {
        queueManager.markDoneById(itemId)
        this.pushQueueToRenderer()
        console.log(
          `[LivePipeline] Frame tracking: "${itemId.slice(0, 8)}" done immediately (strict/non-completed)`
        )
        return
      }
      // Do NOT mark done on backend completion. In append flow, backend can be far
      // ahead of playback. We must advance only when player reports audio-ended.
      this.frameSegmentTrackingQueue.push(itemId)
      this.drainStrictFrameEnded()
      console.log(
        `[LivePipeline] Frame tracking: "${itemId.slice(0, 8)}" buffered (await audio-ended, pending=${this.frameSegmentTrackingQueue.length})`
      )
      return
    }

    const totalChunks = task?.totalChunks || 0

    if (totalChunks <= 0) {
      // No chunks (failed task or non-streaming) — mark done immediately
      queueManager.markDoneById(itemId)
      this.pushQueueToRenderer()
      console.log(`[LivePipeline] Chunk tracking: "${itemId.slice(0, 8)}" done immediately (no chunks)`)
      return
    }

    this.chunkTrackingQueue.push({ itemId, totalChunks, played: 0, chunkDirPath: task?.chunkDirPath })
    console.log(`[LivePipeline] Chunk tracking: registered "${task?.sourceText?.slice(0, 30) || itemId}" (${totalChunks} chunks), queue depth=${this.chunkTrackingQueue.length}`)

    // Apply any pre-played chunks (chunks that finished before this registration)
    if (this.chunkTrackingQueue.length === 1 && this.unassignedChunksPlayed > 0) {
      const head = this.chunkTrackingQueue[0]
      head.played += this.unassignedChunksPlayed
      console.log(`[LivePipeline] Chunk tracking: applied ${this.unassignedChunksPlayed} pre-played chunks to "${itemId.slice(0, 8)}"`)
      this.unassignedChunksPlayed = 0
      this.drainCompletedItems()
    }
  }

  /**
   * Drain any items at the head of the tracking queue that have been fully played.
   * This handles the edge case where pre-played chunks overflow into subsequent items.
   */
  private drainCompletedItems(): void {
    while (this.chunkTrackingQueue.length > 0) {
      const head = this.chunkTrackingQueue[0]
      if (head.played >= head.totalChunks) {
        const { chunkDirPath } = head
        this.chunkTrackingQueue.shift()
        queueManager.markDoneById(head.itemId)
        this.pushQueueToRenderer()
        console.log(`[LivePipeline] Chunk tracking: "${head.itemId.slice(0, 8)}" done (${head.played}/${head.totalChunks}), remaining=${this.chunkTrackingQueue.length}`)
        if (chunkDirPath) pipelineService.cleanupChunkDir(chunkDirPath)
      } else {
        break
      }
    }
  }

  private getBufferedChunkBacklog(): number {
    let buffered = 0
    for (const item of this.chunkTrackingQueue) {
      buffered += Math.max(0, Number(item.totalChunks || 0) - Number(item.played || 0))
    }
    if (this.unassignedChunksPlayed > 0) {
      buffered = Math.max(0, buffered - this.unassignedChunksPlayed)
    }
    return buffered
  }

  private clearChunkTracking(): void {
    this.chunkTrackingQueue = []
    this.unassignedChunksPlayed = 0
    this.frameSegmentTrackingQueue = []
    this.unassignedFrameAudioEnded = 0
  }

  private drainStrictFrameEnded(): void {
    while (this.unassignedFrameAudioEnded > 0 && this.frameSegmentTrackingQueue.length > 0) {
      const itemId = this.frameSegmentTrackingQueue.shift()!
      this.unassignedFrameAudioEnded--
      queueManager.markDoneById(itemId)
      this.pushQueueToRenderer()
      console.log(
        `[LivePipeline] Frame tracking: "${itemId.slice(0, 8)}" done (pre-ended audio, remain=${this.frameSegmentTrackingQueue.length})`
      )
    }
  }

  // ── Renderer sync ─────────────────────────────────────────────────

  private pushQueueToRenderer(): void {
    const win = getMainWindow()
    if (win && !win.isDestroyed()) {
      const displayQueue = queueManager.getDisplayQueue()
      const audibleItemId = this.getAudibleItemId(displayQueue)
      win.webContents.send(
        'live:queue-update',
        displayQueue.map((item) => ({
          ...item,
          isAudible: item.id === audibleItemId
        }))
      )
    }
  }

  private getAudibleItemId(displayQueue: PlaylistItem[]): string | null {
    if (displayQueue.length === 0) return null
    if (isNativeRendererBackendType(getActiveBackendType())) {
      return displayQueue.find((item) => item.status === 'playing')?.id ?? null
    }
    return (
      displayQueue.find((item) => item.status === 'buffered')?.id ??
      displayQueue.find((item) => item.status === 'playing')?.id ??
      null
    )
  }
}

export const livePipelineService = new LivePipelineService()
