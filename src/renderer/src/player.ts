/**
 * Player window entry script
 * Three modes:
 * - idle: loop playlist of static avatar videos (default)
 * - active: play F2F result video once, then return to idle (legacy batch mode)
 * - streaming: play chunks sequentially with double-buffered swap (streaming mode)
 */

const videoA = document.getElementById('videoPlayerA') as HTMLVideoElement
const videoB = document.getElementById('videoPlayerB') as HTMLVideoElement
const cameraVideo = document.getElementById('cameraVideo') as HTMLVideoElement
const frameStreamCanvas = document.getElementById('frameStreamCanvas') as HTMLCanvasElement
const closeBtn = document.getElementById('closeBtn') as HTMLButtonElement
const statusText = document.getElementById('statusText') as HTMLDivElement

let playlist: string[] = []
let currentIndex = 0
let isPlaying = false
let mode: 'idle' | 'active' | 'streaming' | 'frame-streaming' = 'idle'
let resultQueue: string[] = []
type StreamChunk = { path: string; nFrames: number; audioPath?: string | null }
type FrameBatchPayload = {
  codec: 'jpeg'
  fps: number
  width: number
  height: number
  startFrame: number
  frameIndices: number[]
  frames: string[]
  totalFrames?: number
  audioPath?: string
  appendStream?: boolean
  cropRegion?: { x: number; y: number; w: number; h: number }
}
type FramePacket = {
  frameIndex: number
  presentIndex: number
  image: ImageBitmap | HTMLImageElement
  releasable: boolean
}
type PendingFrameSegment = {
  audioPath: string
  fps: number
  width: number
  height: number
  batches: FrameBatchPayload[]
}

// Streaming state (double-buffered)
let activeVideo: HTMLVideoElement = videoA
let standbyVideo: HTMLVideoElement = videoB
let chunkQueue: StreamChunk[] = []
let standbyReady = false
let standbyLoading = false
// Tracks what the standby element is currently loading 鈥?used to safely abort a
// gap-idle preload when a real chunk arrives before the async seek completes.
let standbyLoadMode: 'chunk' | 'gap-idle' | 'idle' | null = null
const videoChunkFrames = new WeakMap<HTMLVideoElement, number>()
const videoChunkAudio = new WeakMap<HTMLVideoElement, string | null>()
let activeChunkFrames = 0
let streamFrameCursor = 0
const streamClockFps = 25
let nextChunkPlaybackRate = 1
let awaitingAudioGate = false
let awaitingDurationGate = false
let activeChunkStartedAtMs = 0

// Frame sync: seek time for resuming idle after streaming
let idleSeekTime = 0
let idlePreloaded = false

// Gap-idle: when consecutive tasks leave a gap between the last chunk of task N and
// the first chunk of task N+1, show the moving idle video at gapSeekTime instead of
// a frozen synthesis frame.  inGapIdle = true while idle is displayed in that gap.
let gapSeekTime = 0
let inGapIdle = false
let gapIdlePreloaded = false  // gap-idle is already seeked on standby, ready for instant swap
let lastReportedStreamQueueDepth = -1
let lastReportedStreamQueueMode = ''

// Camera mode state
let cameraMode = false
let cameraStream: MediaStream | null = null
let cameraProfileId: string | null = null
let cameraRefreshTimer: number | null = null
let cameraFrameInjectionTimer: number | null = null
// Face crop region from F2F preprocessing
let cameraCropRegion: { x: number; y: number; w: number; h: number } | null = null
// Expression transfer: output = camera + (f2f - reference)
// Captures the "baseline" F2F frame (closed mouth). The diff with subsequent F2F
// frames isolates mouth movement, which is added to the live camera pixel-by-pixel.
let cameraRefImageData: ImageData | null = null // reference F2F frame at canvas size
let cameraRefCaptured = false
let cameraExprCanvas: HTMLCanvasElement | null = null // offscreen work canvas for expression transfer
let cameraExprCtx: CanvasRenderingContext2D | null = null
let cameraFadeCanvas: HTMLCanvasElement | null = null // separate canvas for bridge fade blending
let cameraFadeCtx: CanvasRenderingContext2D | null = null
// Legacy overlay canvases (kept for cleanup)
let cameraOverlayCanvas: HTMLCanvasElement | null = null
let cameraOverlayCtx: CanvasRenderingContext2D | null = null
let cameraMaskCanvas: HTMLCanvasElement | null = null
let cameraMaskCtx: CanvasRenderingContext2D | null = null
let cameraMaskKey = ''
// Temporary canvas for camera frame injection
let cameraInjectionCanvas: HTMLCanvasElement | null = null
let cameraInjectionCtx: CanvasRenderingContext2D | null = null
let cameraInjectCount = 0
let streamAudio: HTMLAudioElement | null = null
let streamAudioPath = ''
let sentenceAudioPath = ''
let streamVolume = 1.0
let frameStreamAppendMode = false
let frameStreamAudioQueue: string[] = []

// Frame streaming mode (DIANJT-like): keep idle video continuously playing and
// overlay generated frame stream on top, driven by the same audio clock.
let frameStreamCtx: CanvasRenderingContext2D | null = null
let frameStreamQueue: FramePacket[] = []
let frameStreamLast: FramePacket | null = null
let frameStreamRaf = 0
let frameStreamFps = streamClockFps
let frameStreamWidth = 0
let frameStreamHeight = 0
let frameStreamDone = false
let frameStreamDecodeToken = 0
let frameStreamTotalFrames = 0
let frameStreamDroppedFrames = 0
let frameStreamFirstFrameAtMs = 0
let frameStreamStartAtMs = 0
let frameStreamNextPresentIndex = 0
let frameStreamRenderedPresentIndex = -1
let frameStreamDecodeSuccess = 0
let frameStreamDecodeFailure = 0
let frameStreamLastDecodeLogAt = 0
const FRAME_STREAM_MAX_CATCHUP_FRAMES = 3
// Keep a steady lead buffer so next sentence can overlap backend inference.
const FRAME_STREAM_AUDIO_PREROLL_FRAMES = 8
const FRAME_STREAM_AUDIO_PREROLL_FRAMES_JUNCTION = 2
const FRAME_STREAM_APPEND_PREROLL_FRAMES = 6
const FRAME_STREAM_APPEND_PREROLL_FRAMES_COLD = 12
const FRAME_STREAM_BRIDGE_HOLD_MS = 2200
const FRAME_STREAM_BRIDGE_HOLD_MIN_MS = 1200
const FRAME_STREAM_BRIDGE_HOLD_MAX_MS = 5200
const FRAME_STREAM_BRIDGE_EASE_MS = 220
const FRAME_STREAM_SILENCE_RECOVER_HOLD_MS = 420
const FRAME_STREAM_SILENCE_RECOVER_EASE_MS = 260
const FRAME_STREAM_BRIDGE_LIVE_BLEND_DELAY_MS = 200
const FRAME_STREAM_BRIDGE_LIVE_BLEND_ALPHA_START = 0.96
const FRAME_STREAM_BRIDGE_LIVE_BLEND_ALPHA_END = 0.86
const FRAME_STREAM_JUNCTION_CROSSFADE_MS = 140
const STRICT_APPEND_FRAME_STREAM = true
// Keep transitions stable: overlapping two HTMLAudio elements caused audible
// buzzing/current-noise on some customer machines, so early overlap is disabled.
const EARLY_AUDIO_OVERLAP_SEC = 0
let earlyAudioTransitionPending = false
let frameStreamUnderrunCount = 0
let frameStreamLastUnderrunLogAt = 0
let frameStreamAudioPausedForUnderrun = false
let frameStreamPendingAudioPath = ''
let frameStreamAudioStarted = false
let frameStreamBridgeHoldUntilMs = 0
let frameStreamBridgeHoldDynamicMs = FRAME_STREAM_BRIDGE_HOLD_MS
let frameStreamBridgeHoldActiveMs = FRAME_STREAM_BRIDGE_HOLD_MS
let frameStreamBridgeEaseStartMs = 0
let frameStreamBridgeEaseActiveMs = FRAME_STREAM_BRIDGE_EASE_MS
let frameStreamLastAudioClockSec = 0
let frameStreamLastAudioClockAtMs = 0
let frameStreamAudioTimelineOffsetSec = 0
let frameStreamCrossfadeFrom: FramePacket | null = null
let frameStreamCrossfadeStartMs = 0
let frameStreamCrossfadeUntilMs = 0
let pendingFrameSegment: PendingFrameSegment | null = null
let pendingFrameSegmentLastLogAt = 0
type FrameStreamJunctionState = {
  id: number
  audioEndedAtMs: number
  fallbackFrames: number
  lastFallbackLogAt: number
}
let frameStreamJunctionSeq = 0
let frameStreamJunction: FrameStreamJunctionState | null = null
let strictAppendForcedWarned = false

// ---------------------------------------------------------------------------
// Lazy decode queue: raw (undecoded) base64 frames are buffered here and
// decoded by a paced pump instead of 600 concurrent createImageBitmap calls.
// ---------------------------------------------------------------------------
type RawFrameEntry = { frameIndex: number; base64: string }
let rawFrameBuffer: RawFrameEntry[] = []
let decodePumpRunning = false
const DECODE_AHEAD_TARGET = 90      // keep ~3s decoded buffer at 30fps
const DECODE_PUMP_BATCH = 6         // concurrent createImageBitmap per pump cycle
const DECODE_PUMP_INTERVAL_MS = 4   // pump re-check interval

function reportStreamQueueState(force = false): void {
  const depth = (() => {
    if (mode !== 'frame-streaming') {
      return Math.max(0, chunkQueue.length)
    }
    const fps = frameStreamFps > 1 ? frameStreamFps : streamClockFps
    const frameQueueSec = (frameStreamQueue.length + rawFrameBuffer.length) / Math.max(1, fps)
    // Quantize to avoid sending IPC every rendered frame.
    const frameUnits = Math.max(0, Math.ceil(frameQueueSec / 0.5))
    const audioQueueUnits = Math.max(0, frameStreamAudioQueue.length)
    const pendingAudioUnits = frameStreamPendingAudioPath ? 1 : 0
    const pendingSegUnits = pendingFrameSegment ? 1 : 0
    const activeAudioUnits = streamAudio && !streamAudio.ended ? 1 : 0
    return Math.max(
      frameUnits,
      audioQueueUnits + pendingAudioUnits + pendingSegUnits + activeAudioUnits
    )
  })()
  const currentMode = mode
  if (
    !force &&
    depth === lastReportedStreamQueueDepth &&
    currentMode === lastReportedStreamQueueMode
  ) {
    return
  }
  lastReportedStreamQueueDepth = depth
  lastReportedStreamQueueMode = currentMode
  window.playerApi.setStreamQueueState(depth, currentMode)
}

// Close button
closeBtn.addEventListener('click', () => {
  window.playerApi.closePlayer()
})

// Double-click to toggle always-on-top
document.body.addEventListener('dblclick', () => {
  window.playerApi.toggleAlwaysOnTop()
})

function pathToFileUrl(path: string): string {
  return 'file:///' + path.replace(/\\/g, '/').replace(/^\//, '')
}

function updateStatus(text: string) {
  statusText.textContent = text
}

function normalizeChunkFrames(nFrames: number | null | undefined, fallback: number): number {
  const n = Number(nFrames)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.round(n)
}

function setVideoChunkFrames(video: HTMLVideoElement, nFrames: number): void {
  videoChunkFrames.set(video, Math.max(0, Math.round(nFrames)))
}

function setVideoChunkAudio(video: HTMLVideoElement, audioPath?: string | null): void {
  const path = typeof audioPath === 'string' && audioPath.trim().length > 0 ? audioPath : null
  videoChunkAudio.set(video, path)
}

function getVideoChunkFrames(video: HTMLVideoElement): number {
  const n = videoChunkFrames.get(video)
  return Number.isFinite(n) && (n as number) > 0 ? (n as number) : 0
}

function getVideoChunkAudio(video: HTMLVideoElement): string | null {
  const path = videoChunkAudio.get(video)
  return typeof path === 'string' && path.length > 0 ? path : null
}

function maybeStartChunkAudio(video: HTMLVideoElement): void {
  const chunkAudio = getVideoChunkAudio(video)
  if (!chunkAudio) return
  sentenceAudioPath = chunkAudio
  if (!streamAudio || streamAudioPath !== chunkAudio || streamAudio.ended) {
    startStreamAudio(chunkAudio)
  }
}

function markActiveChunkStart(video: HTMLVideoElement): void {
  const frames = getVideoChunkFrames(video)
  activeChunkStartedAtMs = frames > 0 ? Date.now() : 0
}

function normalizePlaybackRate(rate: number): number {
  if (!Number.isFinite(rate)) return 1
  // Keep rate adjustments narrow to avoid perceivable fast-forward/slow-motion artifacts.
  return Math.max(0.97, Math.min(1.03, rate))
}

function computePlaybackRateFromLead(leadSec: number): number {
  if (!Number.isFinite(leadSec)) return 1
  // lead < 0: audio ahead, speed up video slightly.
  // lead > 0: video ahead, slow down slightly.
  const desired = 1 + (-leadSec * 0.15)
  return normalizePlaybackRate(desired)
}

function getActiveStreamAudioTimeSec(): number {
  if (!streamAudio) return 0
  // Stale audio objects can survive between tasks if first chunk misses audio path.
  // Ignore ended/mismatched clocks to avoid huge lead spikes and playback-rate jumps.
  if (streamAudio.ended) return 0
  if (
    sentenceAudioPath &&
    streamAudioPath &&
    sentenceAudioPath !== streamAudioPath &&
    !frameStreamAppendMode
  ) {
    return 0
  }
  const t = Number(streamAudio.currentTime || 0)
  if (!Number.isFinite(t) || t < 0) return 0
  return t
}

function getFrameStreamClockSec(): number {
  if (frameStreamPendingAudioPath && !frameStreamAudioStarted) return 0
  const audioNow = getActiveStreamAudioTimeSec()
  if (audioNow > 0.0001) {
    const clockNow =
      frameStreamAppendMode ? frameStreamAudioTimelineOffsetSec + audioNow : audioNow
    frameStreamLastAudioClockSec = clockNow
    frameStreamLastAudioClockAtMs = Date.now()
    return clockNow
  }
  // Audio element exists but clock hasn't started yet.
  // In append mode, briefly continue advancing by wall-clock during the micro-gap
  // between audio segments (pre-loaded audio starts in ~1-2 frames).  This keeps
  // frames advancing smoothly instead of freezing.  Cap at 150ms to prevent drift
  // if audio fails to start.
  if (streamAudio && !streamAudio.ended) {
    if (frameStreamAppendMode && frameStreamLastAudioClockAtMs > 0) {
      const elapsed = (Date.now() - frameStreamLastAudioClockAtMs) / 1000
      if (elapsed > 0 && elapsed < 0.15) {
        return frameStreamLastAudioClockSec + elapsed
      }
    }
    return frameStreamLastAudioClockSec
  }
  if (frameStreamAppendMode) return frameStreamLastAudioClockSec
  // Continue from the last observed audio clock to avoid a tail jump when
  // current audio just ended but a few mouth frames remain to render.
  if (frameStreamLastAudioClockAtMs > 0) {
    return (
      frameStreamLastAudioClockSec +
      Math.max(0, (Date.now() - frameStreamLastAudioClockAtMs) / 1000)
    )
  }
  if (frameStreamStartAtMs > 0) {
    return Math.max(0, (Date.now() - frameStreamStartAtMs) / 1000)
  }
  return 0
}

function enqueueFrameStreamAudio(audioPath: string): void {
  const path = String(audioPath || '').trim()
  if (!path) return
  if (streamAudioPath === path) return
  if (frameStreamPendingAudioPath === path) return
  const tail = frameStreamAudioQueue.length > 0 ? frameStreamAudioQueue[frameStreamAudioQueue.length - 1] : ''
  if (tail === path) return
  frameStreamAudioQueue.push(path)
  reportStreamQueueState()
  // Pre-load the head of the queue so it's ready for instant switch.
  const head = frameStreamAudioQueue[0]
  if (head && preloadedAudioPath !== head) {
    preloadNextStreamAudio(head)
  }
  if (frameStreamAudioQueue.length % 4 === 1) {
    console.log(`[FRAME-STREAM] append audio queued=${frameStreamAudioQueue.length}`)
  }
}

function tryStartQueuedFrameAudio(reason: string): boolean {
  if (frameStreamAudioQueue.length <= 0) return false
  const requiredPreroll = getFrameStreamPrerollFrames()
  const head = frameStreamAudioQueue[0] || ''
  if (!head) return false
  // In append mode, when previous audio ended, start next audio immediately
  // without waiting for preroll frames. The Python inference is continuous —
  // frames will arrive shortly. Waiting causes audible silence gaps between
  // sentences because the GPU is slightly behind real-time (underrun).
  const skipPreroll =
    frameStreamAppendMode && (reason === 'audio-ended' || reason === 'audio-drained')
  if (!skipPreroll && frameStreamQueue.length < requiredPreroll && !frameStreamDone) {
    if (!frameStreamPendingAudioPath || frameStreamPendingAudioPath === head) {
      frameStreamPendingAudioPath = head
      frameStreamAudioQueue.shift()
      reportStreamQueueState()
      // Pre-load while waiting for preroll frames.
      if (preloadedAudioPath !== head) {
        preloadNextStreamAudio(head)
      }
    }
    console.log(
      `[FRAME-STREAM] append audio wait reason=${reason} q=${frameStreamQueue.length} need=${requiredPreroll} remain=${frameStreamAudioQueue.length}`
    )
    return false
  }
  const next = frameStreamAudioQueue.shift() || ''
  if (!next) return false
  if (frameStreamPendingAudioPath === next) {
    frameStreamPendingAudioPath = ''
  }
  sentenceAudioPath = next
  reportStreamQueueState()
  startStreamAudio(next)
  console.log(`[FRAME-STREAM] append audio switch reason=${reason} remain=${frameStreamAudioQueue.length}`)
  return true
}

function activateDeferredFrameSegment(reason: string): boolean {
  if (mode !== 'frame-streaming') return false
  if (!pendingFrameSegment) return false
  // In append-stream mode, backend may run faster than realtime. If current
  // sentence audio has ended, do not wait forever for tail queue drain.
  if (frameStreamQueue.length > 0) {
    const canForceSwitch =
      reason === 'audio-ended' || reason === 'audio-drained' || reason === 'silent-overrun'
    if (!canForceSwitch) return false
    const dropped = frameStreamQueue.length
    clearFrameStreamQueue(true)
    console.warn(`[FRAME-STREAM] force switch reason=${reason} dropped_tail_frames=${dropped}`)
  }

  const seg = pendingFrameSegment
  pendingFrameSegment = null
  beginFrameStreaming(seg.audioPath, seg.fps, seg.width, seg.height)
  for (const b of seg.batches) {
    if (typeof b.totalFrames === 'number' && Number.isFinite(b.totalFrames) && b.totalFrames > 0) {
      frameStreamTotalFrames = Math.max(frameStreamTotalFrames, Math.floor(b.totalFrames))
    }
    frameStreamDone = false
    void appendFrameBatch(b)
  }
  console.log(
    `[FRAME-STREAM] activate deferred segment batches=${seg.batches.length} audio=${seg.audioPath} reason=${reason}`
  )
  return true
}

function beginFrameStreamJunction(): void {
  if (STRICT_APPEND_FRAME_STREAM) return
  frameStreamJunctionSeq += 1
  frameStreamJunction = {
    id: frameStreamJunctionSeq,
    audioEndedAtMs: Date.now(),
    fallbackFrames: 0,
    lastFallbackLogAt: 0
  }
  console.log(
    `[AUTO-JUNC] start id=${frameStreamJunction.id} holdMs=${Math.round(frameStreamBridgeHoldDynamicMs)} q=${frameStreamQueue.length} done=${frameStreamDone} pending=${pendingFrameSegment ? 1 : 0}`
  )
}

function settleFrameStreamJunction(reason: 'next-first-frame' | 'timeout'): void {
  if (STRICT_APPEND_FRAME_STREAM) {
    frameStreamJunction = null
    return
  }
  const j = frameStreamJunction
  if (!j) return
  const gapMs = Math.max(0, Date.now() - j.audioEndedAtMs)
  const tailPadMs = 220
  const desiredHold = Math.max(
    FRAME_STREAM_BRIDGE_HOLD_MIN_MS,
    Math.min(FRAME_STREAM_BRIDGE_HOLD_MAX_MS, gapMs + tailPadMs)
  )
  if (gapMs + 80 >= frameStreamBridgeHoldDynamicMs) {
    frameStreamBridgeHoldDynamicMs = Math.max(frameStreamBridgeHoldDynamicMs, desiredHold)
  } else {
    frameStreamBridgeHoldDynamicMs = Math.round(
      frameStreamBridgeHoldDynamicMs * 0.88 + desiredHold * 0.12
    )
  }
  frameStreamBridgeHoldDynamicMs = Math.max(
    FRAME_STREAM_BRIDGE_HOLD_MIN_MS,
    Math.min(FRAME_STREAM_BRIDGE_HOLD_MAX_MS, frameStreamBridgeHoldDynamicMs)
  )
  const smoothScore = Math.max(
    0,
    100 - Math.round(gapMs / 10) - Math.min(20, j.fallbackFrames)
  )
  console.log(
    `[AUTO-JUNC] done id=${j.id} reason=${reason} gapMs=${gapMs} fallbackFrames=${j.fallbackFrames} smooth=${smoothScore} holdMs=${Math.round(frameStreamBridgeHoldDynamicMs)}`
  )
  frameStreamJunction = null
}

function computeAudioGateDelayMs(nextFrameCursor: number): number {
  const audioNow = getFrameStreamClockSec()
  const target = nextFrameCursor / streamClockFps
  const deltaSec = target - audioNow
  if (!Number.isFinite(deltaSec)) return 0
  // Positive delta means video is ahead of audio; hold transition briefly.
  if (deltaSec <= 0.001) return 0
  return Math.round(Math.min(deltaSec, 2.0) * 1000)
}

// ---------------------------------------------------------------------------
// Audio pre-loading: create and buffer the next Audio element while current
// sentence is still playing, so audio switching is near-instant (~1 frame)
// instead of waiting 100-500ms for file I/O + decode.
// ---------------------------------------------------------------------------
let preloadedAudio: HTMLAudioElement | null = null
let preloadedAudioPath = ''

function preloadNextStreamAudio(audioPath: string): void {
  const path = String(audioPath || '').trim()
  if (!path) return
  if (preloadedAudioPath === path && preloadedAudio) return
  cleanupPreloadedAudio()
  preloadedAudioPath = path
  const a = new Audio(pathToFileUrl(path))
  a.preload = 'auto'
  a.volume = streamVolume
  preloadedAudio = a
}

function cleanupPreloadedAudio(): void {
  if (!preloadedAudio) return
  preloadedAudio.oncanplaythrough = null
  preloadedAudio.onended = null
  preloadedAudio.onerror = null
  try { preloadedAudio.pause() } catch { /* ignore */ }
  try { preloadedAudio.src = ''; preloadedAudio.load() } catch { /* ignore */ }
  preloadedAudio = null
  preloadedAudioPath = ''
}

function stopStreamAudio(): void {
  if (!streamAudio) return
  earlyAudioTransitionPending = false
  frameStreamAudioPausedForUnderrun = false
  try {
    window.playerApi.setStreamAudioState(false)
  } catch {
    // ignore
  }
  streamAudio.oncanplaythrough = null
  streamAudio.onended = null
  streamAudio.onerror = null
  try {
    streamAudio.pause()
  } catch {
    // ignore
  }
  try {
    streamAudio.src = ''
    streamAudio.load()
  } catch {
    // ignore
  }
  streamAudio = null
  streamAudioPath = ''
  reportStreamQueueState()
}

function startStreamAudio(audioPath?: string | null): void {
  if (!audioPath) {
    console.warn('[StreamAudio] no audio path')
    return
  }
  if (streamAudio && streamAudioPath === audioPath) {
    if (streamAudio.paused) {
      streamAudio.play().catch((err) => {
        console.error('[StreamAudio] Resume failed:', err)
      })
    } else {
      try {
        window.playerApi.setStreamAudioState(true)
      } catch {
        // ignore
      }
    }
    return
  }

  stopStreamAudio()
  streamAudioPath = audioPath

  // Use pre-loaded audio element if available (near-instant start).
  let a: HTMLAudioElement
  if (preloadedAudio && preloadedAudioPath === audioPath) {
    a = preloadedAudio
    const alreadyPlaying = !a.paused
    preloadedAudio = null
    preloadedAudioPath = ''
    earlyAudioTransitionPending = false
    // When early-adopted, the new audio has been playing for some ms before
    // onended fired and the timeline offset was updated. Subtract the early
    // overlap to keep the frame clock continuous.
    if (alreadyPlaying && frameStreamAppendMode) {
      const earlyTime = Number(a.currentTime || 0)
      if (earlyTime > 0.001 && earlyTime < 0.2) {
        frameStreamAudioTimelineOffsetSec -= earlyTime
        console.log(
          `[StreamAudio] start (preloaded, early-adopted) compensation=-${(earlyTime * 1000).toFixed(0)}ms`,
          audioPath
        )
      } else {
        console.log('[StreamAudio] start (preloaded, early-adopted)', audioPath)
      }
    } else {
      console.log('[StreamAudio] start (preloaded)', audioPath)
    }
  } else {
    earlyAudioTransitionPending = false
    a = new Audio(pathToFileUrl(audioPath))
    a.preload = 'auto'
    console.log('[StreamAudio] start', audioPath)
  }
  a.playbackRate = 1
  a.defaultPlaybackRate = 1
  a.volume = streamVolume
  a.oncanplaythrough = () => {
    console.log('[StreamAudio] canplaythrough')
  }
  a.onended = () => {
    console.log('[StreamAudio] ended')
    frameStreamAudioPausedForUnderrun = false
    if (mode === 'frame-streaming' && frameStreamAppendMode) {
      try {
        window.playerApi.frameAudioEnded(streamAudioPath)
      } catch {
        // ignore
      }
    }
    if (mode === 'frame-streaming' && frameStreamAppendMode) {
      const playedSec = Number(a.currentTime || 0)
      const segDur =
        Number.isFinite(playedSec) && playedSec > 0.001
          ? playedSec
          : Number.isFinite(a.duration) && a.duration > 0
            ? a.duration
            : 0
      if (Number.isFinite(segDur) && segDur > 0) {
        frameStreamAudioTimelineOffsetSec += segDur

        // Drift correction: at segment boundaries, hard-snap the audio timeline
        // to the actual rendered frame position.  The old approach (subtracting
        // only the excess beyond a 2-frame threshold) allowed drift to persist
        // between corrections, and during multi-hour live streams the cumulative
        // error caused 5-20s desync.  By snapping to the rendered position every
        // segment we guarantee the next segment starts with zero drift.
        if (frameStreamFps > 0 && frameStreamRenderedPresentIndex >= 0) {
          const expectedTimeSec = (frameStreamRenderedPresentIndex + 1) / frameStreamFps
          const drift = frameStreamAudioTimelineOffsetSec - expectedTimeSec
          // Correct any drift larger than half a frame in either direction.
          const driftThresholdSec = 0.5 / frameStreamFps
          if (Math.abs(drift) > driftThresholdSec) {
            frameStreamAudioTimelineOffsetSec = expectedTimeSec
            console.log(
              `[FRAME-STREAM] drift snap: drift=${drift.toFixed(3)}s, ` +
              `offset=${frameStreamAudioTimelineOffsetSec.toFixed(3)}s, rendered=${frameStreamRenderedPresentIndex}`
            )
          }
        }
      }
    }
    reportStreamQueueState()
    if (mode === 'frame-streaming' && frameStreamAppendMode && tryStartQueuedFrameAudio('audio-ended')) {
      return
    }
    if (mode === 'frame-streaming' && !STRICT_APPEND_FRAME_STREAM) {
      beginFrameStreamJunction()
    }
    try {
      window.playerApi.setStreamAudioState(false)
    } catch {
      // ignore
    }
    if (pendingFrameSegment && mode === 'frame-streaming') {
      if (!activateDeferredFrameSegment('audio-ended')) {
        console.log(
          `[FRAME-STREAM] audio ended, deferred segment pending buffered=${pendingFrameSegment.batches.length}`
        )
      }
    }
  }
  a.onerror = () => {
    console.error('[StreamAudio] error', audioPath)
    try {
      window.playerApi.setStreamAudioState(false)
    } catch {
      // ignore
    }
  }
  a.play().catch((err) => {
    console.error('[StreamAudio] play failed:', err, audioPath)
    try {
      window.playerApi.setStreamAudioState(false)
    } catch {
      // ignore
    }
  })
  try {
    window.playerApi.setStreamAudioState(true)
  } catch {
    // ignore
  }
  streamAudio = a
  // Pre-load the NEXT audio in queue for the subsequent transition.
  if (frameStreamAudioQueue.length > 0) {
    const nextPath = frameStreamAudioQueue[0]
    if (nextPath && preloadedAudioPath !== nextPath) {
      preloadNextStreamAudio(nextPath)
    }
  }
  reportStreamQueueState()
}

function waitForAudioClockStart(maxWaitMs = 450): Promise<boolean> {
  const startedAt = Date.now()
  return new Promise((resolve) => {
    const poll = () => {
      if (mode !== 'streaming') {
        resolve(false)
        return
      }
      const a = streamAudio
      if (!a) {
        resolve(false)
        return
      }
      const t = Number(a.currentTime || 0)
      if (t >= 0.004) {
        resolve(true)
        return
      }
      if (Date.now() - startedAt >= maxWaitMs) {
        resolve(false)
        return
      }
      setTimeout(poll, 10)
    }
    poll()
  })
}

function ensureFrameStreamCtx(): CanvasRenderingContext2D | null {
  if (frameStreamCtx) return frameStreamCtx
  frameStreamCtx = frameStreamCanvas.getContext('2d')
  return frameStreamCtx
}

function clearFramePacket(pkt: FramePacket | null): void {
  if (!pkt) return
  if (pkt.releasable && pkt.image instanceof ImageBitmap) {
    try {
      pkt.image.close()
    } catch {
      // ignore
    }
  }
}

function clearFrameStreamCrossfade(): void {
  clearFramePacket(frameStreamCrossfadeFrom)
  frameStreamCrossfadeFrom = null
  frameStreamCrossfadeStartMs = 0
  frameStreamCrossfadeUntilMs = 0
}

function clearFrameStreamQueue(keepLastFrame = false): void {
  for (const pkt of frameStreamQueue) clearFramePacket(pkt)
  frameStreamQueue = []
  rawFrameBuffer = []
  clearFrameStreamCrossfade()
  if (!keepLastFrame) {
    clearFramePacket(frameStreamLast)
    frameStreamLast = null
    frameStreamBridgeHoldUntilMs = 0
    frameStreamBridgeEaseStartMs = 0
  }
  reportStreamQueueState()
}

function stopFrameStreamRenderLoop(): void {
  if (frameStreamRaf) {
    cancelAnimationFrame(frameStreamRaf)
    frameStreamRaf = 0
  }
}

function hideFrameStreamCanvas(): void {
  frameStreamCanvas.style.display = 'none'
  if (frameStreamCtx && frameStreamCanvas.width > 0 && frameStreamCanvas.height > 0) {
    frameStreamCtx.clearRect(0, 0, frameStreamCanvas.width, frameStreamCanvas.height)
  }
  // Restore camera to full-screen when canvas is hidden
  if (cameraMode) showCameraIdle()
}

function applyFrameStreamVisualState(): void {
  // Keep idle video visible; frameStreamCanvas draws either generated mouth frames
  // or passthrough idle frames so transition is seamless.
  videoA.style.opacity = '1'
  videoB.style.opacity = '1'
  frameStreamCanvas.style.zIndex = '4'
}

function restoreFrameStreamVisualState(): void {
  videoA.style.opacity = '1'
  videoB.style.opacity = '1'
}

function getFrameStreamPrerollFrames(): number {
  if (frameStreamAppendMode) {
    // Cold-start needs a larger cushion to avoid early audio running ahead
    // during model warmup and the first few slow frame batches.
    if (!frameStreamAudioStarted && frameStreamAudioTimelineOffsetSec <= 0.001) {
      return FRAME_STREAM_APPEND_PREROLL_FRAMES_COLD
    }
    return FRAME_STREAM_APPEND_PREROLL_FRAMES
  }
  if (frameStreamJunction) return FRAME_STREAM_AUDIO_PREROLL_FRAMES_JUNCTION
  return FRAME_STREAM_AUDIO_PREROLL_FRAMES
}

function finishFrameStreaming(reason: string): void {
  if (mode !== 'frame-streaming') return
  console.log(
    `[FRAME-STREAM] finish reason=${reason} dropped=${frameStreamDroppedFrames} total=${frameStreamTotalFrames}`
  )
  stopFrameStreamRenderLoop()
  rawFrameBuffer = []
  decodePumpRunning = false
  cleanupPreloadedAudio()
  clearFrameStreamQueue()
  hideFrameStreamCanvas()
  restoreFrameStreamVisualState()
  frameStreamDone = false
  frameStreamTotalFrames = 0
  frameStreamDroppedFrames = 0
  frameStreamFirstFrameAtMs = 0
  frameStreamStartAtMs = 0
  frameStreamNextPresentIndex = 0
  frameStreamRenderedPresentIndex = -1
  frameStreamPendingAudioPath = ''
  frameStreamAudioStarted = false
  frameStreamBridgeHoldUntilMs = 0
  frameStreamBridgeEaseStartMs = 0
  frameStreamBridgeHoldActiveMs = FRAME_STREAM_BRIDGE_HOLD_MS
  frameStreamBridgeEaseActiveMs = FRAME_STREAM_BRIDGE_EASE_MS
  frameStreamBridgeHoldDynamicMs = FRAME_STREAM_BRIDGE_HOLD_MS
  frameStreamLastAudioClockSec = 0
  frameStreamLastAudioClockAtMs = 0
  frameStreamAudioTimelineOffsetSec = 0
  clearFrameStreamCrossfade()
  frameStreamJunction = null
  pendingFrameSegment = null
  frameStreamAppendMode = false
  frameStreamAudioQueue = []
  stopStreamAudio()
  sentenceAudioPath = ''
  mode = 'idle'
  window.playerApi.resultFinished()
  updateStatus('绌洪棽寰幆 Idle loop')
}

function beginFrameStreaming(audioPath?: string | null, fps?: number, width?: number, height?: number): void {
  const continueFrameStream = mode === 'frame-streaming'
  if (mode === 'streaming') {
    // Safety: never mix chunk and frame transports in one session.
    exitStreamingMode()
  }

  if (mode !== 'frame-streaming') {
    mode = 'frame-streaming'
    chunkQueue = []
    reportStreamQueueState(true)
    standbyReady = false
    standbyLoading = false
    standbyLoadMode = null
    idlePreloaded = false
    idleSeekTime = 0
    gapSeekTime = 0
    gapIdlePreloaded = false
    inGapIdle = false
    activeChunkFrames = 0
    activeChunkStartedAtMs = 0
    streamFrameCursor = 0
    nextChunkPlaybackRate = 1
    awaitingAudioGate = false
    awaitingDurationGate = false
    updateStatus('娴佸紡鎾斁 Streaming (frame)')
    if (cameraMode) {
      // Keep camera element accessible for canvas drawImage (shrink to 1px)
      cameraVideo.style.display = 'block'
      cameraVideo.style.width = '1px'
      cameraVideo.style.height = '1px'
      cameraVideo.style.position = 'fixed'
      cameraVideo.style.bottom = '0'
      cameraVideo.style.right = '0'
      cameraVideo.style.zIndex = '0'
    }
  }
  applyFrameStreamVisualState()

  frameStreamDecodeToken += 1
  frameStreamDone = false
  frameStreamDroppedFrames = 0
  frameStreamFirstFrameAtMs = 0
  frameStreamStartAtMs = Date.now()
  frameStreamTotalFrames = 0
  frameStreamNextPresentIndex = 0
  frameStreamRenderedPresentIndex = -1
  frameStreamDecodeSuccess = 0
  frameStreamDecodeFailure = 0
  frameStreamUnderrunCount = 0
  frameStreamLastUnderrunLogAt = 0
  frameStreamAudioPausedForUnderrun = false
  frameStreamLastDecodeLogAt = 0
  frameStreamPendingAudioPath = ''
  frameStreamAudioStarted = false
  frameStreamBridgeHoldUntilMs = 0
  frameStreamBridgeEaseStartMs = 0
  frameStreamBridgeHoldActiveMs = FRAME_STREAM_BRIDGE_HOLD_MS
  frameStreamBridgeEaseActiveMs = FRAME_STREAM_BRIDGE_EASE_MS
  frameStreamLastAudioClockSec = 0
  frameStreamLastAudioClockAtMs = 0
  if (!continueFrameStream) {
    frameStreamAudioTimelineOffsetSec = 0
  }
  clearFrameStreamCrossfade()
  if (!continueFrameStream) {
    frameStreamBridgeHoldDynamicMs = FRAME_STREAM_BRIDGE_HOLD_MS
    frameStreamJunction = null
    frameStreamAppendMode = false
    frameStreamAudioQueue = []
  }
  pendingFrameSegment = null
  clearFrameStreamQueue(continueFrameStream)

  if (typeof fps === 'number' && Number.isFinite(fps) && fps > 1) {
    frameStreamFps = Math.max(10, Math.min(60, fps))
  } else {
    frameStreamFps = streamClockFps
  }
  if (typeof width === 'number' && Number.isFinite(width) && width > 0) frameStreamWidth = Math.round(width)
  if (typeof height === 'number' && Number.isFinite(height) && height > 0) frameStreamHeight = Math.round(height)

  stopStreamAudio()
  sentenceAudioPath = typeof audioPath === 'string' ? audioPath : ''
  if (sentenceAudioPath) {
    frameStreamPendingAudioPath = sentenceAudioPath
  }

  const ctx = ensureFrameStreamCtx()
  if (!ctx) return
  frameStreamCanvas.style.display = 'block'
  if (!frameStreamRaf) {
    frameStreamRaf = requestAnimationFrame(renderFrameStreamTick)
  }
}

function decodeBase64ToBytes(base64: string): Uint8Array {
  const bin = atob(base64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function decodeBlobFallback(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob)
  try {
    const img = new Image()
    img.decoding = 'sync'
    img.src = url
    if (typeof img.decode === 'function') {
      await img.decode()
    } else {
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve()
        img.onerror = () => reject(new Error('image decode failed'))
      })
    }
    return img
  } finally {
    URL.revokeObjectURL(url)
  }
}

/**
 * appendFrameBatch — now stores raw base64 data in rawFrameBuffer and kicks
 * the decode pump.  This avoids creating hundreds of concurrent
 * createImageBitmap calls that overwhelm the browser JPEG decoder (~25 fps
 * throughput) when GPU inference dumps 600 frames in 1 second.
 */
async function appendFrameBatch(batch: FrameBatchPayload): Promise<void> {
  const token = frameStreamDecodeToken
  const indices = Array.isArray(batch.frameIndices) ? batch.frameIndices : []
  const payloads = Array.isArray(batch.frames) ? batch.frames : []
  const n = Math.min(indices.length, payloads.length)
  if (n <= 0) return

  for (let i = 0; i < n; i++) {
    if (token !== frameStreamDecodeToken || mode !== 'frame-streaming') return
    const idx = Number(indices[i])
    if (!Number.isFinite(idx) || idx < 0) continue
    const b64 = payloads[i]
    if (typeof b64 !== 'string' || b64.length === 0) continue
    rawFrameBuffer.push({ frameIndex: Math.floor(idx), base64: b64 })
  }

  // Kick the decode pump if not already running.
  if (!decodePumpRunning && rawFrameBuffer.length > 0) {
    decodePumpRunning = true
    scheduleDecodePump()
  }
}

function scheduleDecodePump(): void {
  setTimeout(runDecodePump, DECODE_PUMP_INTERVAL_MS)
}

/**
 * Decode pump: processes raw frames from rawFrameBuffer with controlled
 * concurrency (DECODE_PUMP_BATCH at a time).  Throttles when the decoded
 * queue is deep enough, preventing the JPEG decoder from being overwhelmed.
 */
async function runDecodePump(): Promise<void> {
  const token = frameStreamDecodeToken
  if (mode !== 'frame-streaming' || token !== frameStreamDecodeToken) {
    decodePumpRunning = false
    return
  }

  // Throttle: if decoded queue is already large, pause decoding.
  if (frameStreamQueue.length >= DECODE_AHEAD_TARGET && rawFrameBuffer.length > 0) {
    setTimeout(runDecodePump, 30)
    return
  }

  if (rawFrameBuffer.length === 0) {
    decodePumpRunning = false
    return
  }

  // Take a batch of raw frames.
  const batch = rawFrameBuffer.splice(0, DECODE_PUMP_BATCH)

  // Decode all frames in this batch concurrently.
  const results = await Promise.all(
    batch.map(async (entry): Promise<{ frameIndex: number; image: ImageBitmap | HTMLImageElement; releasable: boolean } | null> => {
      try {
        const bytes = decodeBase64ToBytes(entry.base64)
        const blob = new Blob([bytes], { type: 'image/jpeg' })
        let image: ImageBitmap | HTMLImageElement
        let releasable = false
        try {
          image = await createImageBitmap(blob)
          releasable = true
        } catch {
          image = await decodeBlobFallback(blob)
        }
        return { frameIndex: entry.frameIndex, image, releasable }
      } catch {
        return null
      }
    })
  )

  // Check for cancellation after async work.
  if (token !== frameStreamDecodeToken || mode !== 'frame-streaming') {
    for (const r of results) {
      if (r) clearFramePacket({ frameIndex: r.frameIndex, presentIndex: -1, image: r.image, releasable: r.releasable })
    }
    decodePumpRunning = false
    return
  }

  // Enqueue decoded frames.
  for (const r of results) {
    if (!r) {
      frameStreamDecodeFailure += 1
      continue
    }
    frameStreamDecodeSuccess += 1
    frameStreamQueue.push({
      frameIndex: r.frameIndex,
      presentIndex: frameStreamNextPresentIndex++,
      image: r.image,
      releasable: r.releasable
    })
  }

  frameStreamQueue.sort((a, b) => a.presentIndex - b.presentIndex)

  // Check audio preroll: start pending audio once enough frames buffered.
  const requiredPreroll = getFrameStreamPrerollFrames()
  if (
    frameStreamPendingAudioPath &&
    frameStreamQueue.length >= requiredPreroll
  ) {
    startStreamAudio(frameStreamPendingAudioPath)
    frameStreamPendingAudioPath = ''
    if (!frameStreamAudioStarted) frameStreamAudioStarted = true
  }

  // Try to start next queued audio if current ended (segment boundary).
  if ((!streamAudio || streamAudio.ended) && frameStreamAudioQueue.length > 0) {
    tryStartQueuedFrameAudio('decode-pump')
  }

  reportStreamQueueState()
  const now = Date.now()
  if (now - frameStreamLastDecodeLogAt >= 1000) {
    frameStreamLastDecodeLogAt = now
    console.log(
      `[FRAME-STREAM] decode ok=${frameStreamDecodeSuccess} fail=${frameStreamDecodeFailure} queue=${frameStreamQueue.length} rendered=${frameStreamRenderedPresentIndex} raw=${rawFrameBuffer.length}`
    )
  }

  // Continue pumping if there's more work.
  if (rawFrameBuffer.length > 0) {
    scheduleDecodePump()
  } else {
    decodePumpRunning = false
  }
}

function renderFrameStreamTick(): void {
  frameStreamRaf = 0
  if (mode !== 'frame-streaming') return

  const ctx = ensureFrameStreamCtx()
  if (!ctx) {
    frameStreamRaf = requestAnimationFrame(renderFrameStreamTick)
    return
  }

  if (
    frameStreamPendingAudioPath &&
    (
      frameStreamQueue.length >= getFrameStreamPrerollFrames() ||
      (frameStreamDone && frameStreamQueue.length > 0)
    )
  ) {
    startStreamAudio(frameStreamPendingAudioPath)
    frameStreamPendingAudioPath = ''
    if (!frameStreamAudioStarted) frameStreamAudioStarted = true
  }

  const vw = Math.max(2, frameStreamWidth || activeVideo.videoWidth || 720)
  const vh = Math.max(2, frameStreamHeight || activeVideo.videoHeight || 1280)
  if (frameStreamCanvas.width !== vw || frameStreamCanvas.height !== vh) {
    frameStreamCanvas.width = vw
    frameStreamCanvas.height = vh
  }

  // Camera mode: draw live camera as idle background instead of the recorded avatar video
  const idleSource = (cameraMode && cameraVideo.readyState >= 2) ? cameraVideo : activeVideo

  const audioNow = getFrameStreamClockSec()

  // --- Early audio transition: pre-start next audio before current ends ---
  // This hides the HTML5 Audio play() latency (~30-80ms on Windows) that causes
  // a perceptible silence gap between sentences. The two audio elements overlap
  // briefly (~80ms) which is inaudible but eliminates the gap.
  if (
    frameStreamAppendMode &&
    streamAudio &&
    !streamAudio.ended &&
    !earlyAudioTransitionPending &&
    frameStreamAudioQueue.length > 0 &&
    Number.isFinite(streamAudio.duration) &&
    streamAudio.duration > 0.5
  ) {
    const remaining = streamAudio.duration - (streamAudio.currentTime || 0)
    if (remaining > 0 && remaining < EARLY_AUDIO_OVERLAP_SEC) {
      const nextPath = frameStreamAudioQueue[0]
      if (nextPath && preloadedAudio && preloadedAudioPath === nextPath) {
        earlyAudioTransitionPending = true
        preloadedAudio.volume = streamVolume
        preloadedAudio.play().catch(() => { /* ignore */ })
        console.log(
          `[FRAME-STREAM] early audio pre-start remaining=${(remaining * 1000).toFixed(0)}ms`
        )
      }
    }
  }

  const targetPresent = Math.max(0, Math.floor(audioNow * frameStreamFps + 1e-3))
  const cappedTargetPresent =
    frameStreamRenderedPresentIndex >= 0
      ? Math.min(targetPresent, frameStreamRenderedPresentIndex + FRAME_STREAM_MAX_CATCHUP_FRAMES)
      : targetPresent

  let candidate: FramePacket | null = null
  while (frameStreamQueue.length > 0 && frameStreamQueue[0].presentIndex <= cappedTargetPresent) {
    candidate = frameStreamQueue.shift()!
  }
  // Fallback: if timeline/index mismatch happens, still show earliest frame to avoid "no mouth movement".
  if (!candidate && !frameStreamLast && frameStreamQueue.length > 0) {
    candidate = frameStreamQueue.shift()!
  }
  if (!candidate && frameStreamQueue.length > 0) {
    const head = frameStreamQueue[0]
    if (targetPresent - head.presentIndex > Math.max(1, Math.round(frameStreamFps * 0.1))) {
      candidate = frameStreamQueue.shift()!
    }
  }
  // ── Underrun audio resume ──────────────────────────────────────────
  // Resume audio as soon as we have a frame to render. Snap the timeline
  // so that the current rendered position equals the audio clock — this
  // eliminates any drift that would have accumulated without the pause.
  if (candidate && frameStreamAudioPausedForUnderrun && streamAudio && streamAudio.paused) {
    // Reset timeline offset so that offset + audioCurrentTime == rendered frame time.
    // This provides a clean sync point instead of carrying accumulated error.
    const renderedTimeSec = (frameStreamRenderedPresentIndex + 1) / Math.max(1, frameStreamFps)
    const audioPos = Number(streamAudio.currentTime || 0)
    if (Number.isFinite(renderedTimeSec) && Number.isFinite(audioPos)) {
      frameStreamAudioTimelineOffsetSec = renderedTimeSec - audioPos
    }
    streamAudio.play().catch(() => { /* ignore */ })
    frameStreamAudioPausedForUnderrun = false
    console.log(
      `[FRAME-STREAM] underrun → audio RESUMED rendered=${frameStreamRenderedPresentIndex} offset=${frameStreamAudioTimelineOffsetSec.toFixed(3)}s`
    )
  }
  if (candidate) {
    const prevFrame = frameStreamLast
    const isFirstFrameOfSegment = frameStreamFirstFrameAtMs === 0
    if (
      frameStreamRenderedPresentIndex >= 0 &&
      candidate.presentIndex - frameStreamRenderedPresentIndex > 1
    ) {
      frameStreamDroppedFrames += Math.max(
        0,
        candidate.presentIndex - frameStreamRenderedPresentIndex - 1
      )
    }
    if (isFirstFrameOfSegment && frameStreamJunction && prevFrame) {
      clearFrameStreamCrossfade()
      frameStreamCrossfadeFrom = prevFrame
      frameStreamCrossfadeStartMs = Date.now()
      frameStreamCrossfadeUntilMs = frameStreamCrossfadeStartMs + FRAME_STREAM_JUNCTION_CROSSFADE_MS
      console.log(
        `[AUTO-JUNC] crossfade id=${frameStreamJunction.id} ms=${FRAME_STREAM_JUNCTION_CROSSFADE_MS}`
      )
    } else {
      clearFramePacket(prevFrame)
    }
    frameStreamLast = candidate
    frameStreamRenderedPresentIndex = candidate.presentIndex
    if (isFirstFrameOfSegment) {
      frameStreamFirstFrameAtMs = Date.now()
      console.log(
        `[FRAME-STREAM] first_frame latency_ms=${Math.max(0, frameStreamFirstFrameAtMs - frameStreamStartAtMs)} fps=${frameStreamFps.toFixed(2)}`
      )
      if (frameStreamJunction) {
        settleFrameStreamJunction('next-first-frame')
      }
    }
  }
  if (!candidate && frameStreamQueue.length === 0 && !frameStreamDone && streamAudio && !streamAudio.ended) {
    frameStreamUnderrunCount += 1
    // Safety: re-kick decode pump if raw frames are waiting but pump died.
    if (rawFrameBuffer.length > 0 && !decodePumpRunning) {
      decodePumpRunning = true
      scheduleDecodePump()
    }
    // ── Underrun audio pause ──────────────────────────────────────────
    // Pause audio when frames can't keep up to prevent the audio timeline
    // from running ahead of the video.  Without this, the offset grows
    // unboundedly during long underrun windows and the lip-sync drifts by
    // seconds (or even tens of seconds in multi-hour live streams).
    if (frameStreamAppendMode && !frameStreamAudioPausedForUnderrun && !streamAudio.paused) {
      streamAudio.pause()
      frameStreamAudioPausedForUnderrun = true
      console.warn(
        `[FRAME-STREAM] underrun → audio PAUSED rendered=${frameStreamRenderedPresentIndex} target=${targetPresent}`
      )
    }
    const now = Date.now()
    if (now - frameStreamLastUnderrunLogAt >= 1000) {
      frameStreamLastUnderrunLogAt = now
      console.warn(
        `[FRAME-STREAM] underrun count=${frameStreamUnderrunCount} rendered=${frameStreamRenderedPresentIndex} target=${targetPresent} raw=${rawFrameBuffer.length}`
      )
    }
  }

  const expectedDuration =
    frameStreamTotalFrames > 0 ? frameStreamTotalFrames / Math.max(1, frameStreamFps) : 0
  const audioEnded = !streamAudio || streamAudio.ended
  // Do not end the segment while audio is still playing; this avoids
  // the "last character freezes for a moment" artifact.
  const timelineTailReached = !streamAudio && expectedDuration > 0 && audioNow >= expectedDuration - 0.02
  // Queue drained + audio ended is enough to start the next sentence; do not
  // hard-block on frameStreamDone because its IPC can arrive slightly later.
  const segmentDrained = frameStreamQueue.length === 0 && (audioEnded || timelineTailReached)
  const segmentDone = frameStreamDone && segmentDrained
  if (
    segmentDrained &&
    pendingFrameSegment &&
    activateDeferredFrameSegment(segmentDone ? 'segment-drained' : 'audio-drained')
  ) {
    return
  }
  if (segmentDrained && frameStreamLast && frameStreamBridgeHoldUntilMs <= 0) {
    const noPendingNext = !pendingFrameSegment
    const holdMs = noPendingNext
      ? Math.max(
          FRAME_STREAM_SILENCE_RECOVER_HOLD_MS,
          FRAME_STREAM_SILENCE_RECOVER_EASE_MS + 80
        )
      : Math.round(frameStreamBridgeHoldDynamicMs)
    const easeMs = noPendingNext
      ? FRAME_STREAM_SILENCE_RECOVER_EASE_MS
      : FRAME_STREAM_BRIDGE_EASE_MS
    // Keep the final synthesized frame briefly so short inter-sentence gaps
    // do not flash back to the raw idle video.
    frameStreamBridgeHoldActiveMs = holdMs
    frameStreamBridgeEaseActiveMs = easeMs
    frameStreamBridgeHoldUntilMs = Date.now() + holdMs
    // Only blend to idle near hold timeout. If next sentence arrives in time,
    // users won't see a mid-gap fallback to closed-mouth idle.
    frameStreamBridgeEaseStartMs = Math.max(
      Date.now(),
      frameStreamBridgeHoldUntilMs - easeMs
    )
  } else if (!segmentDrained) {
    frameStreamBridgeHoldUntilMs = 0
    frameStreamBridgeEaseStartMs = 0
    frameStreamBridgeHoldActiveMs = FRAME_STREAM_BRIDGE_HOLD_MS
    frameStreamBridgeEaseActiveMs = FRAME_STREAM_BRIDGE_EASE_MS
  }
  if (
    frameStreamBridgeHoldUntilMs > 0 &&
    segmentDrained
  ) {
    const noPendingNext = !pendingFrameSegment
    const canSmoothRelease =
      noPendingNext &&
      frameStreamQueue.length === 0 &&
      (!streamAudio || streamAudio.ended) &&
      activeVideo.readyState >= 2 &&
      !activeVideo.paused
    if (Date.now() >= frameStreamBridgeHoldUntilMs && noPendingNext && !canSmoothRelease) {
      clearFramePacket(frameStreamLast)
      frameStreamLast = null
      frameStreamBridgeHoldUntilMs = 0
      frameStreamBridgeEaseStartMs = 0
      frameStreamBridgeHoldActiveMs = FRAME_STREAM_BRIDGE_HOLD_MS
      frameStreamBridgeEaseActiveMs = FRAME_STREAM_BRIDGE_EASE_MS
      if (frameStreamJunction) {
        settleFrameStreamJunction('timeout')
      }
    }
  }

  frameStreamCanvas.style.display = 'block'
  ctx.clearRect(0, 0, vw, vh)
  ctx.imageSmoothingEnabled = true

  // === CAMERA MODE: same as video mode ===
  // The avatar is a short camera recording, F2F output is displayed directly.
  // Camera mode only affects idle view (live camera instead of looping video).
  // No special rendering needed — falls through to standard rendering below.

  // === STANDARD (NON-CAMERA) RENDERING ===
  if (frameStreamLast) {
    let renderedByCrossfade = false
    if (frameStreamCrossfadeFrom && frameStreamCrossfadeUntilMs > frameStreamCrossfadeStartMs) {
      const now = Date.now()
      if (now < frameStreamCrossfadeUntilMs) {
        const t = Math.max(
          0,
          Math.min(1, (now - frameStreamCrossfadeStartMs) / Math.max(1, FRAME_STREAM_JUNCTION_CROSSFADE_MS))
        )
        ctx.globalAlpha = 1
        ctx.drawImage(frameStreamCrossfadeFrom.image, 0, 0, vw, vh)
        ctx.globalAlpha = t
        ctx.drawImage(frameStreamLast.image, 0, 0, vw, vh)
        ctx.globalAlpha = 1
        renderedByCrossfade = true
      } else {
        clearFrameStreamCrossfade()
      }
    } else if (frameStreamCrossfadeFrom) {
      clearFrameStreamCrossfade()
    }
    if (!renderedByCrossfade) {
      const canBridgeEase =
        frameStreamBridgeHoldUntilMs > 0 &&
        segmentDrained &&
        frameStreamQueue.length === 0 &&
        (!streamAudio || streamAudio.ended) &&
        activeVideo.readyState >= 2 &&
        !activeVideo.paused &&
        !pendingFrameSegment
      if (canBridgeEase) {
        const now = Date.now()
        const holdStartMs = Math.max(
          0,
          frameStreamBridgeHoldUntilMs - Math.max(1, Math.round(frameStreamBridgeHoldActiveMs))
        )
        const elapsedMs = Math.max(0, now - holdStartMs)
        // Stage A: keep mouth shape but inject slight body motion underlay, so it
        // doesn't look frozen while waiting for the next segment's first frame.
        if (elapsedMs >= FRAME_STREAM_BRIDGE_LIVE_BLEND_DELAY_MS && now < frameStreamBridgeEaseStartMs) {
          const stageSpan = Math.max(
            1,
            frameStreamBridgeEaseStartMs - holdStartMs - FRAME_STREAM_BRIDGE_LIVE_BLEND_DELAY_MS
          )
          const stageT = Math.max(
            0,
            Math.min(1, (elapsedMs - FRAME_STREAM_BRIDGE_LIVE_BLEND_DELAY_MS) / stageSpan)
          )
          const alpha =
            FRAME_STREAM_BRIDGE_LIVE_BLEND_ALPHA_START +
            (FRAME_STREAM_BRIDGE_LIVE_BLEND_ALPHA_END - FRAME_STREAM_BRIDGE_LIVE_BLEND_ALPHA_START) * stageT
          ctx.globalAlpha = 1
          ctx.drawImage(idleSource, 0, 0, vw, vh)
          ctx.globalAlpha = alpha
          ctx.drawImage(frameStreamLast.image, 0, 0, vw, vh)
          ctx.globalAlpha = 1
        } else if (now >= frameStreamBridgeEaseStartMs) {
          // Stage B: only near bridge timeout, fade to full idle.
          const t = Math.max(
            0,
            Math.min(1, (now - frameStreamBridgeEaseStartMs) / Math.max(1, frameStreamBridgeEaseActiveMs))
          )
          if (t > 0.001) {
            ctx.globalAlpha = 1
            ctx.drawImage(idleSource, 0, 0, vw, vh)
            ctx.globalAlpha = 1 - t
            ctx.drawImage(frameStreamLast.image, 0, 0, vw, vh)
            ctx.globalAlpha = 1
            if (t >= 0.999) {
              clearFramePacket(frameStreamLast)
              frameStreamLast = null
              frameStreamBridgeHoldUntilMs = 0
              frameStreamBridgeEaseStartMs = 0
              frameStreamBridgeHoldActiveMs = FRAME_STREAM_BRIDGE_HOLD_MS
              frameStreamBridgeEaseActiveMs = FRAME_STREAM_BRIDGE_EASE_MS
            }
          } else {
            ctx.drawImage(frameStreamLast.image, 0, 0, vw, vh)
          }
        } else {
          ctx.drawImage(frameStreamLast.image, 0, 0, vw, vh)
        }
      } else {
        ctx.drawImage(frameStreamLast.image, 0, 0, vw, vh)
      }
    }
  } else if ((activeVideo.readyState >= 2 && !activeVideo.paused) ||
             (cameraMode && cameraVideo.readyState >= 2)) {
    if (frameStreamJunction && frameStreamRenderedPresentIndex >= 0) {
      frameStreamJunction.fallbackFrames += 1
      const now = Date.now()
      if (now - frameStreamJunction.lastFallbackLogAt >= 500) {
        frameStreamJunction.lastFallbackLogAt = now
        console.warn(
          `[AUTO-JUNC] fallback frame id=${frameStreamJunction.id} count=${frameStreamJunction.fallbackFrames}`
        )
      }
    }
    // Bridge mode: while waiting for next audio segment, keep showing the same
    // continuous idle timeline on the same canvas to avoid visible source switching.
    // Camera mode: draw live camera instead of recorded avatar video.
    ctx.drawImage(idleSource, 0, 0, vw, vh)
  } else {
    hideFrameStreamCanvas()
  }

  reportStreamQueueState()
  frameStreamRaf = requestAnimationFrame(renderFrameStreamTick)
}

function handleFrameBatch(batch: FrameBatchPayload): void {
  if (!batch || batch.codec !== 'jpeg') return
  // Update face crop region for camera overlay mode
  if (batch.cropRegion && batch.cropRegion.w > 0 && batch.cropRegion.h > 0) {
    cameraCropRegion = batch.cropRegion
  }
  const incomingAudioPath =
    typeof batch.audioPath === 'string' && batch.audioPath.trim().length > 0
      ? batch.audioPath.trim()
      : ''
  const appendStream = batch.appendStream === true || STRICT_APPEND_FRAME_STREAM
  if (STRICT_APPEND_FRAME_STREAM && batch.appendStream !== true && !strictAppendForcedWarned) {
    strictAppendForcedWarned = true
    console.warn('[FRAME-STREAM][STRICT] Missing appendStream flag; forced append path')
  }

  // Match realtime_live_preview.py: append stream is treated as one continuous
  // frame timeline. Audio is advanced by append_ack/play_audio queue, not by
  // repeatedly re-initializing frame-stream state on every sentence.
  if (appendStream) {
    frameStreamAppendMode = true
    if (mode !== 'frame-streaming') {
      beginFrameStreaming(incomingAudioPath || null, batch.fps, batch.width, batch.height)
    } else {
      if (typeof batch.fps === 'number' && Number.isFinite(batch.fps) && batch.fps > 1) {
        frameStreamFps = Math.max(10, Math.min(60, batch.fps))
      }
      if (typeof batch.width === 'number' && Number.isFinite(batch.width) && batch.width > 0) {
        frameStreamWidth = Math.round(batch.width)
      }
      if (typeof batch.height === 'number' && Number.isFinite(batch.height) && batch.height > 0) {
        frameStreamHeight = Math.round(batch.height)
      }
      if (incomingAudioPath && incomingAudioPath !== streamAudioPath) {
        enqueueFrameStreamAudio(incomingAudioPath)
      }
      if (!streamAudio || streamAudio.ended) {
        tryStartQueuedFrameAudio('batch-arrival')
      }
    }

    if (typeof batch.totalFrames === 'number' && Number.isFinite(batch.totalFrames) && batch.totalFrames > 0) {
      frameStreamTotalFrames = Math.max(frameStreamTotalFrames, Math.floor(batch.totalFrames))
    }
    frameStreamDone = false
    frameStreamBridgeHoldUntilMs = 0
    void appendFrameBatch(batch)
    return
  }

  // Keep current sentence continuous: if next sentence frames arrive early, buffer them
  // and switch only after current segment has really drained (audio + tail viseme queue).
  const isNextSentence =
    mode === 'frame-streaming' &&
    streamAudioPath &&
    incomingAudioPath &&
    incomingAudioPath !== streamAudioPath
  const currentAudioPlaying = !!streamAudio && !streamAudio.ended
  // Defer only while current sentence audio is still active.
  // If audio has ended, force switching to next sentence to avoid "first sentence has audio, rest silent".
  const currentSegmentBusy = currentAudioPlaying
  if (isNextSentence && currentSegmentBusy) {
    if (!pendingFrameSegment || pendingFrameSegment.audioPath !== incomingAudioPath) {
      pendingFrameSegment = {
        audioPath: incomingAudioPath,
        fps: batch.fps,
        width: batch.width,
        height: batch.height,
        batches: []
      }
    }
    pendingFrameSegment.batches.push({
      ...batch,
      // Prevent recursive beginFrameStreaming when flushing deferred batches.
      audioPath: undefined
    })
    const now = Date.now()
    if (now - pendingFrameSegmentLastLogAt >= 600) {
      pendingFrameSegmentLastLogAt = now
      console.log(
        `[FRAME-STREAM] defer next segment audio=${incomingAudioPath} buffered=${pendingFrameSegment.batches.length} playing=${currentAudioPlaying} tailQ=${frameStreamQueue.length} done=${frameStreamDone}`
      )
    }
    return
  }

  if (typeof batch.audioPath === 'string' && batch.audioPath.trim().length > 0) {
    beginFrameStreaming(batch.audioPath, batch.fps, batch.width, batch.height)
  } else if (mode !== 'frame-streaming') {
    // Defensive: recover if first packet lost its audioPath metadata.
    beginFrameStreaming(sentenceAudioPath || streamAudioPath || null, batch.fps, batch.width, batch.height)
  } else {
    if (typeof batch.fps === 'number' && Number.isFinite(batch.fps) && batch.fps > 1) {
      frameStreamFps = Math.max(10, Math.min(60, batch.fps))
    }
    if (typeof batch.width === 'number' && Number.isFinite(batch.width) && batch.width > 0) {
      frameStreamWidth = Math.round(batch.width)
    }
    if (typeof batch.height === 'number' && Number.isFinite(batch.height) && batch.height > 0) {
      frameStreamHeight = Math.round(batch.height)
    }
  }

  if (typeof batch.totalFrames === 'number' && Number.isFinite(batch.totalFrames) && batch.totalFrames > 0) {
    frameStreamTotalFrames = Math.max(frameStreamTotalFrames, Math.floor(batch.totalFrames))
  }
  frameStreamDone = false
  frameStreamBridgeHoldUntilMs = 0
  void appendFrameBatch(batch)
}

function getStandby(): HTMLVideoElement {
  return activeVideo === videoA ? videoB : videoA
}

/**
 * Swap active and standby video elements for seamless transition.
 */
function swapVideos(): void {
  const next = getStandby()
  const old = activeVideo
  console.log(
    `[SWAP] ${activeVideo === videoA ? 'A' : 'B'}=>${next === videoA ? 'A' : 'B'} inGapIdle=${inGapIdle} gapIdlePreloaded=${gapIdlePreloaded} standbyReady=${standbyReady}`
  )

  // Show standby on top and start playing
  const appliedRate = normalizePlaybackRate(nextChunkPlaybackRate)
  next.playbackRate = appliedRate
  next.defaultPlaybackRate = appliedRate
  next.style.display = 'block'
  next.style.zIndex = '2'
  const completeSwap = () => {
    // Hide old active only after next has entered playback to avoid black frames on play failure.
    old.pause()
    old.style.zIndex = '1'
    old.style.display = 'none'

    // Update references
    activeVideo = next
    standbyVideo = old
    activeChunkFrames = getVideoChunkFrames(activeVideo)
    markActiveChunkStart(activeVideo)
    maybeStartChunkAudio(activeVideo)
    standbyReady = false
    standbyLoading = false
    standbyLoadMode = null
  }

  next.play()
    .then(() => {
      completeSwap()
    })
    .catch((err) => {
      console.error('Swap play failed:', err)
      // Keep old active stream alive; discard failed standby and retry preload.
      next.pause()
      next.style.display = 'none'
      next.style.zIndex = '1'
      if (old.paused) {
        old.play().catch((playErr) => console.error('Swap rollback play failed:', playErr))
      }
      standbyReady = false
      standbyLoading = false
      standbyLoadMode = null
      if (mode === 'streaming' && chunkQueue.length > 0) {
        preloadNextChunk()
      }
    })
}

/**
 * Preload next chunk into standby video element.
 * If no chunks remain and idleSeekTime is set, preload idle video instead.
 */
function preloadNextChunk(): void {
  if (standbyLoading) return

  if (chunkQueue.length > 0) {
    const nextChunk = chunkQueue.shift()!
    reportStreamQueueState()
    const nextPath = nextChunk.path
    const sb = getStandby()
    standbyLoading = true
    standbyReady = false

    sb.src = pathToFileUrl(nextPath)
    setVideoChunkFrames(sb, nextChunk.nFrames)
    setVideoChunkAudio(sb, nextChunk.audioPath ?? null)
    sb.muted = true
    sb.playbackRate = 1
    sb.defaultPlaybackRate = 1
    sb.preload = 'auto'
    sb.style.display = 'none'

    standbyLoadMode = 'chunk'
    sb.oncanplaythrough = () => {
      sb.oncanplaythrough = null
      standbyReady = true
      standbyLoading = false
      standbyLoadMode = null
      console.log(`[PRELOAD] chunk ready on standby, chunkQ=${chunkQueue.length}`)
    }

    sb.onerror = () => {
      sb.onerror = null
      standbyReady = false
      standbyLoading = false
      standbyLoadMode = null
      console.error('Preload chunk failed:', nextPath)
      preloadNextChunk()
    }
  } else if (idleSeekTime > 0 && !idlePreloaded) {
    // No more chunks 鈥?preload idle video for seamless end transition
    preloadIdleVideo()
  } else if (gapSeekTime > 0 && !gapIdlePreloaded && idleSeekTime === 0) {
    // Last chunk is now playing; standby just became free.
    // Pre-load gap-idle NOW so the transition is instant when this chunk ends.
    preloadGapIdleVideo()
  }
}

/**
 * Pre-load gap-idle video on standby so the swap is instant when the last chunk ends.
 * Called from preloadNextChunk() when the queue drains while gapSeekTime is set.
 */
function preloadGapIdleVideo(): void {
  if (standbyLoading || standbyReady || gapIdlePreloaded || gapSeekTime === 0 || playlist.length === 0) return

  console.log(`[PRELOAD-GAP] start gapST=${gapSeekTime.toFixed(2)} chunkQ=${chunkQueue.length}`)
  const t = gapSeekTime
  const path = playlist[currentIndex]
  const sb = getStandby()
  standbyLoading = true
  standbyReady = false
  standbyLoadMode = 'gap-idle'

  sb.src = pathToFileUrl(path)
  setVideoChunkFrames(sb, 0)
  setVideoChunkAudio(sb, null)
  sb.muted = true
  sb.preload = 'auto'
  sb.style.display = 'none'

  sb.oncanplaythrough = () => {
    sb.oncanplaythrough = null
    sb.onerror = null
    // Check if cancelled between start and canplaythrough
    if (standbyLoadMode !== 'gap-idle') {
      standbyLoading = false
      return
    }
    if (t > 0) {
      sb.currentTime = t
      sb.onseeked = () => {
        sb.onseeked = null
        standbyLoading = false
        // Check again: a chunk may have arrived and cancelled this preload
        // while the seek was in progress. If so, do NOT set gapIdlePreloaded.
        if (standbyLoadMode === 'gap-idle') {
          standbyLoadMode = null
          gapIdlePreloaded = true
          console.log(`[GapIdle] PRE-LOADED at t=${t.toFixed(3)}s chunkQ=${chunkQueue.length} idleST=${idleSeekTime.toFixed(2)}`)
        } else {
          standbyLoadMode = null
          console.log('[GapIdle] Pre-load aborted (chunk arrived during seek)')
          // Standby is now free 鈥?preload any waiting chunk
          if (chunkQueue.length > 0 && !standbyReady) {
            preloadNextChunk()
          }
        }
      }
    } else {
      standbyLoading = false
      if (standbyLoadMode === 'gap-idle') {
        standbyLoadMode = null
        gapIdlePreloaded = true
      } else {
        standbyLoadMode = null
      }
    }
  }

  sb.onerror = () => {
    sb.onerror = null
    sb.oncanplaythrough = null
    standbyLoading = false
    standbyLoadMode = null
    console.error('[GapIdle] Pre-load failed')
  }
}

/**
 * Emergency fallback while waiting for next task metadata:
 * preload idle loop at t=0 so we do not freeze on the last viseme frame.
 */
function preloadEmergencyGapIdleVideo(): void {
  if (standbyLoading || standbyReady || gapIdlePreloaded || playlist.length === 0) return

  const path = playlist[currentIndex]
  const sb = getStandby()
  standbyLoading = true
  standbyReady = false
  standbyLoadMode = 'gap-idle'

  sb.src = pathToFileUrl(path)
  setVideoChunkFrames(sb, 0)
  setVideoChunkAudio(sb, null)
  sb.muted = true
  sb.preload = 'auto'
  sb.style.display = 'none'

  sb.oncanplaythrough = () => {
    sb.oncanplaythrough = null
    sb.onerror = null
    standbyLoading = false
    if (standbyLoadMode === 'gap-idle') {
      standbyLoadMode = null
      gapIdlePreloaded = true
      console.log(`[GapIdle] EMERGENCY PRE-LOADED at t=0.000s chunkQ=${chunkQueue.length} idleST=${idleSeekTime.toFixed(2)} gapST=${gapSeekTime.toFixed(2)}`)
    } else {
      standbyLoadMode = null
      if (chunkQueue.length > 0 && !standbyReady) preloadNextChunk()
    }
  }

  sb.onerror = () => {
    sb.onerror = null
    sb.oncanplaythrough = null
    standbyLoading = false
    standbyLoadMode = null
    console.error('[GapIdle] Emergency pre-load failed')
  }
}

/**
 * Preload idle video on standby and seek to continuation point.
 * Called when pipeline is done (idleSeekTime set) and no more chunks to preload.
 */
function preloadIdleVideo(): void {
  if (idlePreloaded || standbyLoading || standbyReady || playlist.length === 0) return

  console.log(`[PRELOAD-IDLE] start idleST=${idleSeekTime.toFixed(2)} chunkQ=${chunkQueue.length}`)
  const seekTime = idleSeekTime
  const path = playlist[currentIndex]
  const sb = getStandby()
  standbyLoading = true
  standbyLoadMode = 'idle'

  sb.src = pathToFileUrl(path)
  setVideoChunkFrames(sb, 0)
  setVideoChunkAudio(sb, null)
  sb.muted = true // idle video must always be silent
  sb.preload = 'auto'
  sb.style.display = 'none'

  sb.oncanplaythrough = () => {
    sb.oncanplaythrough = null
    sb.onerror = null
    if (seekTime > 0) {
      sb.currentTime = seekTime
      sb.onseeked = () => {
        sb.onseeked = null
        idlePreloaded = true
        standbyLoading = false
        standbyLoadMode = null
        console.log(`[FrameSync] Idle preloaded and seeked to ${seekTime.toFixed(3)}s`)
      }
    } else {
      idlePreloaded = true
      standbyLoading = false
      standbyLoadMode = null
      console.log('[FrameSync] Idle preloaded (no seek needed)')
    }
  }

  sb.onerror = () => {
    sb.onerror = null
    sb.oncanplaythrough = null
    standbyLoading = false
    standbyLoadMode = null
    console.error('[FrameSync] Idle preload failed')
  }
}

// =====================================================================
// Camera Mode
// =====================================================================

/**
 * Capture the current F2F frame as the reference baseline for expression transfer.
 * Should be called once when the first F2F frame arrives (mouth nearly closed).
 */
function captureExpressionReference(image: ImageBitmap | HTMLImageElement, vw: number, vh: number): void {
  if (!cameraExprCanvas) {
    cameraExprCanvas = document.createElement('canvas')
    cameraExprCtx = cameraExprCanvas.getContext('2d')!
  }
  cameraExprCanvas.width = vw
  cameraExprCanvas.height = vh
  cameraExprCtx!.drawImage(image, 0, 0, vw, vh)
  cameraRefImageData = cameraExprCtx!.getImageData(0, 0, vw, vh)
  cameraRefCaptured = true
  console.log(`[Camera ExprTransfer] Reference captured: ${vw}x${vh}`)
}

/**
 * Expression Transfer rendering for camera mode.
 *
 * Formula: output = camera + (f2f - reference)
 *
 * The diff (f2f - reference) isolates the mouth movement from the F2F engine.
 * Adding it to the live camera seamlessly transfers the lip sync to the real-time
 * feed — no masks, no overlays, no visible boundaries.
 *
 * Processing is limited to the face crop region for performance.
 */
function renderExpressionTransfer(
  ctx: CanvasRenderingContext2D,
  f2fImage: ImageBitmap | HTMLImageElement,
  vw: number, vh: number
): void {
  if (!cameraRefImageData || cameraRefImageData.width !== vw || cameraRefImageData.height !== vh) {
    // No valid reference — fall back to drawing F2F directly
    ctx.drawImage(f2fImage, 0, 0, vw, vh)
    return
  }

  if (!cameraExprCanvas) {
    cameraExprCanvas = document.createElement('canvas')
    cameraExprCtx = cameraExprCanvas.getContext('2d')!
  }
  if (cameraExprCanvas.width !== vw || cameraExprCanvas.height !== vh) {
    cameraExprCanvas.width = vw
    cameraExprCanvas.height = vh
  }
  const ectx = cameraExprCtx!

  // 1. Draw live camera → get pixel data
  ectx.drawImage(cameraVideo, 0, 0, vw, vh)
  const camData = ectx.getImageData(0, 0, vw, vh)

  // 2. Draw F2F frame → get pixel data
  ectx.drawImage(f2fImage, 0, 0, vw, vh)
  const f2fData = ectx.getImageData(0, 0, vw, vh)

  // 3. Reference data (baseline F2F with closed mouth)
  const ref = cameraRefImageData.data
  const f2f = f2fData.data
  const cam = camData.data

  // 4. Determine processing region (face crop area + padding)
  let x1 = 0, y1 = 0, x2 = vw, y2 = vh
  if (cameraCropRegion) {
    const sx = vw / Math.max(1, frameStreamWidth || vw)
    const sy = vh / Math.max(1, frameStreamHeight || vh)
    const pad = Math.round(Math.max(cameraCropRegion.w * sx, cameraCropRegion.h * sy) * 0.15)
    x1 = Math.max(0, Math.floor(cameraCropRegion.x * sx) - pad)
    y1 = Math.max(0, Math.floor(cameraCropRegion.y * sy) - pad)
    x2 = Math.min(vw, Math.ceil((cameraCropRegion.x + cameraCropRegion.w) * sx) + pad)
    y2 = Math.min(vh, Math.ceil((cameraCropRegion.y + cameraCropRegion.h) * sy) + pad)
  }

  // 5. Expression transfer: cam + (f2f - ref), clamped to [0,255]
  // Soft edge blending: fade the diff to zero near the region boundary
  const fadeW = Math.max(8, Math.round((x2 - x1) * 0.12))
  const fadeH = Math.max(8, Math.round((y2 - y1) * 0.12))

  for (let y = y1; y < y2; y++) {
    // Vertical fade factor
    let fy = 1.0
    if (y < y1 + fadeH) fy = (y - y1) / fadeH
    else if (y > y2 - fadeH) fy = (y2 - y) / fadeH

    const rowOff = y * vw
    for (let x = x1; x < x2; x++) {
      // Horizontal fade factor
      let fx = 1.0
      if (x < x1 + fadeW) fx = (x - x1) / fadeW
      else if (x > x2 - fadeW) fx = (x2 - x) / fadeW

      const fade = fx * fy
      const i = (rowOff + x) * 4

      // Signed diff, scaled by fade
      const dr = (f2f[i] - ref[i]) * fade
      const dg = (f2f[i + 1] - ref[i + 1]) * fade
      const db = (f2f[i + 2] - ref[i + 2]) * fade

      // Apply to camera pixel
      let r = cam[i] + dr
      let g = cam[i + 1] + dg
      let b = cam[i + 2] + db
      cam[i] = r < 0 ? 0 : r > 255 ? 255 : r
      cam[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g
      cam[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b
    }
  }

  // 6. Output
  ctx.putImageData(camData, 0, 0)
}

function showCameraIdle(): void {
  if (!cameraMode) return
  cameraVideo.style.display = 'block'
  if (chromaEnabled) {
    // Chroma mode: shrink camera to 1x1px so canvas drawImage can read it
    cameraVideo.style.width = '1px'
    cameraVideo.style.height = '1px'
    cameraVideo.style.position = 'fixed'
    cameraVideo.style.bottom = '0'
    cameraVideo.style.right = '0'
    cameraVideo.style.zIndex = '1'
  } else {
    // Camera mode: show live camera full-screen as idle view
    cameraVideo.style.width = '100%'
    cameraVideo.style.height = '100%'
    cameraVideo.style.position = 'absolute'
    cameraVideo.style.top = '0'
    cameraVideo.style.left = '0'
    cameraVideo.style.zIndex = '2'
    videoA.style.display = 'none'
    videoB.style.display = 'none'
  }
}

const CAMERA_RECORD_DURATION_MS = 4000 // 录制4秒摄像头视频作为avatar

async function captureAndSend(): Promise<void> {
  if (!cameraStream || !cameraProfileId) return
  console.log(`[Camera] Recording ${CAMERA_RECORD_DURATION_MS}ms video for avatar...`)

  // Wait for camera video element to have actual frame data
  if (cameraVideo.readyState < 2 || cameraVideo.videoWidth === 0) {
    console.log('[Camera] Waiting for camera to produce frames...')
    await new Promise<void>((resolve) => {
      const check = () => {
        if (cameraVideo.readyState >= 2 && cameraVideo.videoWidth > 0) {
          resolve()
        } else {
          setTimeout(check, 100)
        }
      }
      cameraVideo.addEventListener('loadeddata', () => resolve(), { once: true })
      setTimeout(check, 100)
      setTimeout(() => resolve(), 5000)
    })
    await new Promise(r => setTimeout(r, 200))
  }

  // Use MediaRecorder to record camera stream as WebM
  const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
    ? 'video/webm;codecs=vp9'
    : MediaRecorder.isTypeSupported('video/webm;codecs=vp8')
      ? 'video/webm;codecs=vp8'
      : 'video/webm'
  console.log(`[Camera] MediaRecorder mime: ${mimeType}`)

  const recorder = new MediaRecorder(cameraStream, {
    mimeType,
    videoBitsPerSecond: 4_000_000 // 4 Mbps for good quality
  })

  const chunks: Blob[] = []
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data)
  }

  const recordingDone = new Promise<Blob>((resolve, reject) => {
    recorder.onstop = () => {
      if (chunks.length === 0) {
        reject(new Error('No data recorded'))
        return
      }
      resolve(new Blob(chunks, { type: mimeType }))
    }
    recorder.onerror = (e) => reject(e)
  })

  recorder.start(500) // collect data every 500ms
  console.log('[Camera] Recording started...')

  // Wait for recording duration
  await new Promise(r => setTimeout(r, CAMERA_RECORD_DURATION_MS))
  recorder.stop()

  const webmBlob = await recordingDone
  const buffer = await webmBlob.arrayBuffer()
  console.log(`[Camera] Recording complete: ${(buffer.byteLength / 1024).toFixed(0)} KB WebM`)

  // Send WebM to main process (will be converted to MP4 by ffmpeg)
  const result = await window.playerApi.sendCameraCapture(cameraProfileId!, buffer)
  if (result?.ok) {
    console.log('[Camera] Avatar video created:', result.filePath)
    window.playerApi.cameraCaptureReady(result.filePath)
  } else {
    console.error('[Camera] Recording save failed:', result?.error)
  }
}

const CAMERA_REINIT_INTERVAL_MS = 30_000 // 30s — refresh face tracking coords

/**
 * Periodically capture a single camera frame → JPEG → 1s static MP4 → refreshCameraAvatar.
 * Runs every 30s to keep face detection coordinates and alpha masks fresh.
 * The re-init happens at the next pipeline task boundary (no interruption to active inference).
 */
async function idleRecapture(): Promise<void> {
  if (!cameraStream || !cameraMode || !cameraProfileId) return
  if (cameraVideo.readyState < 2 || cameraVideo.videoWidth === 0) return

  try {
    const c = cameraInjectionCanvas || document.createElement('canvas')
    c.width = cameraVideo.videoWidth
    c.height = cameraVideo.videoHeight
    const cx = c.getContext('2d')!
    cx.drawImage(cameraVideo, 0, 0)

    const blob = await new Promise<Blob>((resolve) =>
      c.toBlob((b) => resolve(b!), 'image/jpeg', 0.90)
    )
    const buffer = await blob.arrayBuffer()

    // profile.ipc.ts detects JPEG magic bytes (0xFF 0xD8) and generates 1s@25fps static MP4
    const result = await window.playerApi.sendCameraCapture(cameraProfileId!, buffer)
    if (result?.ok) {
      console.log('[Camera] Idle re-capture → MP4:', result.filePath)
      window.playerApi.cameraCaptureReady(result.filePath)
    }
  } catch (err) {
    console.warn('[Camera] Idle re-capture failed:', err)
  }
}

/**
 * Capture a camera frame and send it as JPEG base64 directly to the F2F engine
 * for real-time frame injection. No MP4 conversion or re-init needed.
 */
function injectCameraFrame(): void {
  if (!cameraStream || !cameraMode) return
  if (cameraVideo.readyState < 2 || cameraVideo.videoWidth === 0) return

  const vw = cameraVideo.videoWidth
  const vh = cameraVideo.videoHeight

  if (!cameraInjectionCanvas) {
    cameraInjectionCanvas = document.createElement('canvas')
    cameraInjectionCtx = cameraInjectionCanvas.getContext('2d')!
  }
  if (cameraInjectionCanvas.width !== vw || cameraInjectionCanvas.height !== vh) {
    cameraInjectionCanvas.width = vw
    cameraInjectionCanvas.height = vh
  }

  cameraInjectionCtx!.drawImage(cameraVideo, 0, 0, vw, vh)

  // Convert to JPEG base64 and send to F2F engine
  const dataUrl = cameraInjectionCanvas.toDataURL('image/jpeg', 0.80)
  const base64 = dataUrl.substring(dataUrl.indexOf(',') + 1)
  cameraInjectCount++
  if (cameraInjectCount <= 3 || cameraInjectCount % 50 === 0) {
    console.log(`[Camera INJECT] frame #${cameraInjectCount}: ${vw}x${vh}, ${(base64.length / 1024).toFixed(0)} KB`)
  }
  window.playerApi.injectCameraFrame(base64)
}

async function enableCamera(deviceId: string, profileId: string): Promise<void> {
  cameraProfileId = profileId
  cameraMode = true
  // Reset expression transfer state for new session
  cameraRefImageData = null
  cameraRefCaptured = false

  const stream = await navigator.mediaDevices.getUserMedia({
    video: { deviceId: { exact: deviceId } },
    audio: false
  })
  cameraStream = stream
  cameraVideo.srcObject = stream
  cameraVideo.style.display = 'block'

  showCameraIdle()

  updateStatus('正在录制摄像头视频...')

  // Record a short video clip from camera as avatar (same as video mode)
  await captureAndSend()

  // Start live frame injection at 5fps — sends camera JPEG to F2F engine
  // so get_batch_original_frames() returns the live camera frame during inference
  if (cameraFrameInjectionTimer) clearInterval(cameraFrameInjectionTimer)
  cameraFrameInjectionTimer = window.setInterval(injectCameraFrame, 200) as unknown as number

  // NOTE: idle re-capture (30s timer) has been removed.
  // It was causing catastrophic disruption: interrupted active streams,
  // single-frame MP4s failed face detection, caused 100+ underruns.
  // The initial 4s recording provides stable face coordinates, and
  // frame injection provides live camera background — no re-init needed.

  updateStatus('摄像头已连接 Camera connected')
}

function disableCamera(): void {
  cameraMode = false
  cameraCropRegion = null
  cameraRefImageData = null
  cameraRefCaptured = false
  cameraExprCanvas = null
  cameraExprCtx = null
  cameraFadeCanvas = null
  cameraFadeCtx = null
  cameraMaskKey = ''
  cameraMaskCanvas = null
  cameraMaskCtx = null
  cameraOverlayCanvas = null
  cameraOverlayCtx = null
  cameraInjectionCanvas = null
  cameraInjectionCtx = null
  cameraInjectCount = 0
  if (cameraStream) {
    cameraStream.getTracks().forEach(t => t.stop())
    cameraStream = null
  }
  cameraVideo.style.display = 'none'
  cameraVideo.style.width = ''
  cameraVideo.style.height = ''
  cameraVideo.style.position = ''
  cameraVideo.style.bottom = ''
  cameraVideo.style.right = ''
  cameraVideo.srcObject = null
  if (cameraRefreshTimer) {
    clearInterval(cameraRefreshTimer)
    cameraRefreshTimer = null
  }
  if (cameraFrameInjectionTimer) {
    clearInterval(cameraFrameInjectionTimer)
    cameraFrameInjectionTimer = null
  }
  // Notify F2F engine to stop using live camera frames
  window.playerApi.clearCameraFrame()
  cameraProfileId = null
}

// Unified ended handler for both video elements
function onVideoEnded(this: HTMLVideoElement) {
  if (this !== activeVideo) return

  if (mode === 'frame-streaming') {
    // In frame streaming mode, idle video is the continuous background timeline.
    activeVideo.currentTime = 0
    activeVideo.play().catch(console.error)
    return
  }

  if (mode === 'streaming') {
    if (inGapIdle) {
      // Gap-idle video reached its end (avatar videos are usually long so this is rare).
      // Loop from the beginning to keep natural body motion while waiting for next chunk.
      console.log('[ENDED] inGapIdle loop')
      activeVideo.currentTime = 0
      activeVideo.play().catch(console.error)
      return
    }

    if (!awaitingDurationGate) {
      const completedFrames = activeChunkFrames
      if (completedFrames > 0 && activeChunkStartedAtMs > 0) {
        const effectiveRate = Math.max(0.5, Number(activeVideo.playbackRate || 1))
        const expectedMs = (completedFrames * 1000) / (streamClockFps * effectiveRate)
        const elapsedMs = Date.now() - activeChunkStartedAtMs
        if (elapsedMs + 8 < expectedMs) {
          const waitMs = Math.round(Math.min(expectedMs - elapsedMs, 1200))
          awaitingDurationGate = true
          console.log(
            `[DUR-GATE] hold=${waitMs}ms frames=${completedFrames} rate=${effectiveRate.toFixed(3)} expected=${expectedMs.toFixed(1)} elapsed=${elapsedMs.toFixed(1)}`
          )
          setTimeout(() => {
            if (mode !== 'streaming' || this !== activeVideo) {
              awaitingDurationGate = false
              return
            }
            awaitingDurationGate = false
            onVideoEnded.call(this)
          }, waitMs)
          return
        }
      }
    } else {
      awaitingDurationGate = false
    }

    if (!awaitingAudioGate) {
      if (!streamAudio && sentenceAudioPath) {
        console.warn('[AV-SYNC] stream audio missing at chunk end, retry start:', sentenceAudioPath)
        startStreamAudio(sentenceAudioPath)
      }
      // Notify main process that a chunk finished playing (for queue highlight tracking)
      window.playerApi.chunkPlayed()

      const completedFrames = activeChunkFrames
      activeChunkFrames = 0
      activeChunkStartedAtMs = 0
        if (completedFrames > 0) {
          const nextFrameCursor = streamFrameCursor + completedFrames
          const waitMs = computeAudioGateDelayMs(nextFrameCursor)
          if (waitMs > 0) {
            awaitingAudioGate = true
            const targetAudio = nextFrameCursor / streamClockFps
            const audioNow = getActiveStreamAudioTimeSec()
            console.log(
              `[AV-SYNC] hold=${waitMs}ms frames=${completedFrames} targetAudio=${targetAudio.toFixed(3)} now=${audioNow.toFixed(3)}`
            )
            setTimeout(() => {
            if (mode !== 'streaming' || this !== activeVideo) {
              awaitingAudioGate = false
              return
            }
            streamFrameCursor = nextFrameCursor
            awaitingAudioGate = false
            onVideoEnded.call(this)
          }, waitMs)
          return
        }
        streamFrameCursor = nextFrameCursor
        const audioNow = getActiveStreamAudioTimeSec()
        const targetAudio = streamFrameCursor / streamClockFps
        const lead = targetAudio - audioNow
        const desiredRate = computePlaybackRateFromLead(lead)
        nextChunkPlaybackRate = normalizePlaybackRate(nextChunkPlaybackRate * 0.65 + desiredRate * 0.35)
        console.log(
          `[AV-STAT] frameCursor=${streamFrameCursor} targetAudio=${targetAudio.toFixed(3)} now=${audioNow.toFixed(3)} lead=${lead.toFixed(3)} nextRate=${nextChunkPlaybackRate.toFixed(3)}`
        )
      }
    } else {
      awaitingAudioGate = false
    }

    console.log(`[ENDED] sbReady=${standbyReady} sbLoading=${standbyLoading} chunkQ=${chunkQueue.length} idlePreloaded=${idlePreloaded} gapIdlePreloaded=${gapIdlePreloaded} idleST=${idleSeekTime.toFixed(2)} gapST=${gapSeekTime.toFixed(2)} frameCursor=${streamFrameCursor}`)

    if (standbyReady) {
      // Seamless swap to preloaded chunk
      console.log('[ENDED鈫?] standbyReady swap')
      swapVideos()
      preloadNextChunk()
    } else if (chunkQueue.length > 0) {
      // Chunk available but not preloaded 鈥?load and play directly
      // Reset idle preload since new chunks take priority
      console.log(`[ENDED鈫?] direct play from chunkQ (${chunkQueue.length})`)
      idlePreloaded = false
      const nextChunk = chunkQueue.shift()!
      reportStreamQueueState()
      updateStatus(`娴佸紡鎾斁 Streaming... (${chunkQueue.length} queued)`)
      activeVideo.src = pathToFileUrl(nextChunk.path)
      setVideoChunkFrames(activeVideo, nextChunk.nFrames)
      setVideoChunkAudio(activeVideo, nextChunk.audioPath ?? null)
      activeChunkFrames = nextChunk.nFrames
      markActiveChunkStart(activeVideo)
      activeVideo.muted = true
      const appliedRate = normalizePlaybackRate(nextChunkPlaybackRate)
      activeVideo.playbackRate = appliedRate
      activeVideo.defaultPlaybackRate = appliedRate
      maybeStartChunkAudio(activeVideo)
      activeVideo.play().catch(console.error)
      preloadNextChunk()
    } else if (idlePreloaded) {
      // No more chunks, idle video is preloaded on standby 鈥?instant seamless swap
      console.log('[ENDED鈫?] idlePreloaded swap')
      mode = 'idle'
      idleSeekTime = 0
      idlePreloaded = false
      standbyReady = false
      standbyLoading = false
      window.playerApi.resultFinished()
      updateStatus('绌洪棽寰幆 Idle loop')
      swapVideos()
      console.log('[FrameSync] Seamless swap to preloaded idle')
    } else if (gapIdlePreloaded && idleSeekTime === 0 && gapSeekTime > 0) {
      // Gap-idle was pre-loaded while the last chunk was playing 鈥?instant seamless swap,
      // zero frozen-frame delay.
      console.log('[ENDED鈫?] gapIdlePreloaded instant swap')
      gapIdlePreloaded = false
      gapSeekTime = 0
      inGapIdle = true
      swapVideos()
      activeVideo.muted = true
      console.log('[GapIdle] Instant swap to pre-loaded gap-idle')
    } else if (standbyLoading || idleSeekTime === 0) {
      // standbyLoading: something is loading on standby 鈥?wait for it.
      // idleSeekTime === 0: pipeline seekTime not yet received, more tasks still coming.
      //
      console.log('[ENDED鈫?] entering polling loop')
      // If standby is free and gapSeekTime is set, kick off gap-idle preload right now
      // (synchronously, before the first setInterval tick).
      if (!standbyLoading && !standbyReady && gapSeekTime > 0 && !gapIdlePreloaded && idleSeekTime === 0 && playlist.length > 0) {
        preloadGapIdleVideo()
      }
      let waitCount = 0
      const checkInterval = setInterval(() => {
        waitCount++
        if (waitCount > 500) { // 10s safety timeout
          clearInterval(checkInterval)
          console.warn('[FrameSync] Wait timeout (10s), falling back to idle')
          exitStreamingMode()
          return
        }
        if (standbyReady) {
          console.log('[POLL鈫?] standbyReady')
          clearInterval(checkInterval)
          swapVideos()
          preloadNextChunk()
        } else if (gapIdlePreloaded && idleSeekTime === 0 && gapSeekTime > 0) {
          // Gap-idle finished preloading while we were waiting 鈥?instant swap
          console.log('[POLL鈫?] gapIdlePreloaded')
          clearInterval(checkInterval)
          gapIdlePreloaded = false
          gapSeekTime = 0
          inGapIdle = true
          swapVideos()
          activeVideo.muted = true
          console.log('[GapIdle] Polling: instant swap to gap-idle')
        } else if (chunkQueue.length > 0 && !standbyLoading) {
          // New chunk arrived and standby is free 鈥?pick it up.
          // Guard: if standby is loading a previous chunk, wait for standbyReady instead.
          console.log(`[POLL鈫?] chunkQ=${chunkQueue.length}`)
          clearInterval(checkInterval)
          idlePreloaded = false
          const nextChunk = chunkQueue.shift()!
          reportStreamQueueState()
          updateStatus(`娴佸紡鎾斁 Streaming... (${chunkQueue.length} queued)`)
          activeVideo.src = pathToFileUrl(nextChunk.path)
          setVideoChunkFrames(activeVideo, nextChunk.nFrames)
          setVideoChunkAudio(activeVideo, nextChunk.audioPath ?? null)
          activeChunkFrames = nextChunk.nFrames
          markActiveChunkStart(activeVideo)
          activeVideo.muted = true
          const appliedRate = normalizePlaybackRate(nextChunkPlaybackRate)
          activeVideo.playbackRate = appliedRate
          activeVideo.defaultPlaybackRate = appliedRate
          maybeStartChunkAudio(activeVideo)
          activeVideo.play().catch(console.error)
          preloadNextChunk()
        } else if (idlePreloaded) {
          console.log('[POLL鈫?] idlePreloaded')
          clearInterval(checkInterval)
          mode = 'idle'
          idleSeekTime = 0
          idlePreloaded = false
          standbyReady = false
          standbyLoading = false
          standbyLoadMode = null
          window.playerApi.resultFinished()
          updateStatus('绌洪棽寰幆 Idle loop')
          swapVideos()
          console.log('[FrameSync] Seamless swap to preloaded idle (waited)')
        } else if (!standbyLoading && idleSeekTime > 0) {
          // Pipeline is truly done (seekTime now received) 鈥?exit to idle
          console.log(`[POLL鈫?] EXIT idleST=${idleSeekTime.toFixed(2)} sbLoading=${standbyLoading} chunkQ=${chunkQueue.length}`)
          clearInterval(checkInterval)
          exitStreamingMode()
        }
      }, 20)
    } else {
      // Pipeline done (idleSeekTime > 0), nothing loading or ready 鈥?fallback exit
      console.log(`[ENDED鈫抏lse] fallback EXIT idleST=${idleSeekTime.toFixed(2)} chunkQ=${chunkQueue.length}`)
      exitStreamingMode()
    }
    return
  }

  if (mode === 'active') {
    if (resultQueue.length > 0) {
      const next = resultQueue.shift()!
      updateStatus(`椹卞姩鎾斁 Playing chunk... (${resultQueue.length} queued)`)
      activeVideo.src = pathToFileUrl(next)
      setVideoChunkFrames(activeVideo, 0)
      activeChunkFrames = 0
      activeChunkStartedAtMs = 0
      activeVideo.muted = false
      activeVideo.play().catch((err) => {
        console.error('Chunk play failed:', err)
        activeVideo.muted = true
        activeVideo.play().catch(() => {
          mode = 'idle'
          resultQueue = []
          window.playerApi.resultFinished()
          setTimeout(() => playCurrent(), 500)
        })
      })
    } else {
      mode = 'idle'
      window.playerApi.resultFinished()
      updateStatus('绌洪棽寰幆 Idle loop')
      playCurrent()
    }
    return
  }

  // Idle mode: play next in loop
  playNext()
}

function exitStreamingMode(): void {
  console.warn(`[EXIT-STREAMING] idleST=${idleSeekTime.toFixed(2)} gapST=${gapSeekTime.toFixed(2)} chunkQ=${chunkQueue.length} sbLoading=${standbyLoading} sbReady=${standbyReady} cameraMode=${cameraMode}`)
  console.warn(new Error('[EXIT-STREAMING stack]').stack?.split('\n').slice(0, 4).join(' | '))
  mode = 'idle'
  chunkQueue = []
  reportStreamQueueState(true)
  stopStreamAudio()
  sentenceAudioPath = ''
  gapSeekTime = 0
  gapIdlePreloaded = false
  inGapIdle = false
  activeChunkFrames = 0
  activeChunkStartedAtMs = 0
  streamFrameCursor = 0
  awaitingAudioGate = false
  awaitingDurationGate = false
  window.playerApi.resultFinished()

  // Camera mode: restore live camera feed instead of idle video
  if (cameraMode) {
    updateStatus('鎽勫儚澶村凡杩炴帴 Camera connected')
    standbyReady = false
    standbyLoading = false
    standbyLoadMode = null
    idlePreloaded = false
    idleSeekTime = 0
    showCameraIdle()
    return
  }

  updateStatus('绌洪棽寰幆 Idle loop')

  if (idlePreloaded) {
    // Already preloaded 鈥?instant swap
    const seekTime = idleSeekTime
    idleSeekTime = 0
    idlePreloaded = false
    standbyReady = false
    standbyLoading = false
    standbyLoadMode = null
    swapVideos()
    console.log(`[FrameSync] Instant swap to preloaded idle at ${seekTime.toFixed(3)}s`)
    return
  }

  // Fallback: idle wasn't preloaded, load it now
  standbyReady = false
  standbyLoading = false
  standbyLoadMode = null
  idlePreloaded = false

  if (playlist.length === 0) return

  const seekTime = idleSeekTime
  idleSeekTime = 0
  const path = playlist[currentIndex]
  const sb = getStandby()
  sb.src = pathToFileUrl(path)
  setVideoChunkFrames(sb, 0)
  setVideoChunkAudio(sb, null)
  sb.muted = true // idle video must always be silent
  sb.preload = 'auto'
  sb.style.display = 'none'

  sb.oncanplaythrough = () => {
    sb.oncanplaythrough = null
    if (seekTime > 0) {
      sb.currentTime = seekTime
    }
    setTimeout(() => {
      swapVideos()
      console.log(`[FrameSync] Resumed idle at ${seekTime.toFixed(3)}s (fallback)`)
    }, 50)
  }

  sb.onerror = () => {
    sb.onerror = null
    playCurrent()
  }
}

videoA.addEventListener('ended', onVideoEnded)
videoB.addEventListener('ended', onVideoEnded)

// Video error
function onVideoError(this: HTMLVideoElement) {
  if (this !== activeVideo) return
  console.error('Video playback error:', this.error)
  console.error(
    `[VideoErrorDetail] src=${this.currentSrc || this.src} ready=${this.readyState} size=${this.videoWidth}x${this.videoHeight} duration=${Number(this.duration || 0).toFixed(3)}`
  )
  updateStatus(`鎾斁閿欒 Error: ${this.error?.message || 'unknown'}`)

  if (mode === 'streaming') {
    // Count errored chunk as consumed (for queue highlight tracking)
    window.playerApi.chunkPlayed()

    // Try next chunk
    if (chunkQueue.length > 0 || standbyReady) {
      if (standbyReady) {
        swapVideos()
        preloadNextChunk()
      } else {
        const nextChunk = chunkQueue.shift()!
        reportStreamQueueState()
        activeVideo.src = pathToFileUrl(nextChunk.path)
        setVideoChunkFrames(activeVideo, nextChunk.nFrames)
        setVideoChunkAudio(activeVideo, nextChunk.audioPath ?? null)
        activeChunkFrames = nextChunk.nFrames
        markActiveChunkStart(activeVideo)
        activeVideo.muted = true
        const appliedRate = normalizePlaybackRate(nextChunkPlaybackRate)
        activeVideo.playbackRate = appliedRate
        activeVideo.defaultPlaybackRate = appliedRate
        maybeStartChunkAudio(activeVideo)
        activeVideo.play().catch(console.error)
      }
      return
    }
    exitStreamingMode()
    return
  }

  if (mode === 'frame-streaming') {
    // Keep background timeline alive; do not touch audio-driven mouth stream.
    activeVideo.play().catch(() => {
      playCurrent()
    })
    return
  }

  if (mode === 'active') {
    mode = 'idle'
    window.playerApi.resultFinished()
  }
  setTimeout(() => playNext(), 1000)
}

videoA.addEventListener('error', onVideoError)
videoB.addEventListener('error', onVideoError)

function playNext() {
  if (cameraMode) {
    showCameraIdle()
    return
  }
  if (playlist.length === 0) {
    isPlaying = false
    updateStatus('鎾斁鍒楄〃涓虹┖ Playlist empty')
    return
  }
  currentIndex = (currentIndex + 1) % playlist.length
  playCurrent()
}

function playCurrent() {
  if (mode === 'frame-streaming') {
    frameStreamDecodeToken += 1
    stopFrameStreamRenderLoop()
    clearFrameStreamQueue()
    hideFrameStreamCanvas()
    restoreFrameStreamVisualState()
    frameStreamDone = false
    frameStreamTotalFrames = 0
    frameStreamDroppedFrames = 0
    frameStreamFirstFrameAtMs = 0
    frameStreamStartAtMs = 0
    frameStreamNextPresentIndex = 0
    frameStreamRenderedPresentIndex = -1
    frameStreamAppendMode = false
    frameStreamAudioQueue = []
    mode = 'idle'
  }
  stopStreamAudio()
  sentenceAudioPath = ''
  if (cameraMode) {
    showCameraIdle()
    return
  }
  if (playlist.length === 0) return

  const path = playlist[currentIndex]
  const fileName = path.split(/[\\/]/).pop() || ''
  updateStatus(`${currentIndex + 1}/${playlist.length}: ${fileName}`)

  // Ensure we're using videoA for idle mode
  activeVideo = videoA
  standbyVideo = videoB
  videoA.style.display = 'block'
  videoA.style.zIndex = '2'
  videoB.style.display = 'none'
  videoB.style.zIndex = '1'

  activeVideo.src = pathToFileUrl(path)
  setVideoChunkFrames(activeVideo, 0)
  setVideoChunkAudio(activeVideo, null)
  activeChunkFrames = 0
  activeChunkStartedAtMs = 0
  activeVideo.muted = true // idle video must always be silent
  activeVideo.play().catch((err) => {
    console.error('Play failed:', err)
    setTimeout(() => playNext(), 1000)
  })
  isPlaying = true
}

/**
 * Play a F2F result video once (legacy active mode).
 */
function playResult(videoPath: string) {
  if (mode === 'frame-streaming') {
    frameStreamDecodeToken += 1
    stopFrameStreamRenderLoop()
    clearFrameStreamQueue()
    hideFrameStreamCanvas()
    restoreFrameStreamVisualState()
    frameStreamDone = false
    frameStreamTotalFrames = 0
    frameStreamDroppedFrames = 0
    frameStreamFirstFrameAtMs = 0
    frameStreamStartAtMs = 0
    frameStreamNextPresentIndex = 0
    frameStreamRenderedPresentIndex = -1
    frameStreamAppendMode = false
    frameStreamAudioQueue = []
    mode = 'idle'
  }
  stopStreamAudio()
  sentenceAudioPath = ''
  if (mode === 'active') {
    resultQueue.push(videoPath)
    updateStatus(`椹卞姩鎾斁涓?(${resultQueue.length} queued)`)
    return
  }

  mode = 'active'
  resultQueue = []
  updateStatus('椹卞姩鎾斁 Playing result...')

  activeVideo.src = pathToFileUrl(videoPath)
  setVideoChunkFrames(activeVideo, 0)
  setVideoChunkAudio(activeVideo, null)
  activeChunkFrames = 0
  activeChunkStartedAtMs = 0
  activeVideo.muted = false
  activeVideo.play().catch((err) => {
    console.error('Result play failed:', err)
    activeVideo.muted = true
    activeVideo.play().catch(() => {
      mode = 'idle'
      resultQueue = []
      window.playerApi.resultFinished()
      setTimeout(() => playCurrent(), 500)
    })
  })
  isPlaying = true
}

/**
 * Handle streaming chunk from pipeline.
 * First chunk starts playback, subsequent chunks queue for double-buffered swap.
 */
function playChunk(chunkPath: string, streamAudioPath?: string | null, chunkFrames?: number | null) {
  const fname = chunkPath.split(/[\\/]/).pop()
  const normalizedAudioPath =
    typeof streamAudioPath === 'string' && streamAudioPath.trim().length > 0 ? streamAudioPath : null
  const isFirst = mode !== 'streaming' || inGapIdle
  const normalizedFrames = normalizeChunkFrames(chunkFrames, isFirst ? 12 : 16)
  console.log(
    `[CHUNK] ${fname} | frames=${normalizedFrames} mode=${mode} inGapIdle=${inGapIdle} chunkQ=${chunkQueue.length} sbReady=${standbyReady} sbLoading=${standbyLoading} => ${isFirst ? 'FIRST' : 'subsequent'}`
  )
  if (mode !== 'streaming' || inGapIdle) {
    if (mode === 'frame-streaming') {
      frameStreamDecodeToken += 1
      stopFrameStreamRenderLoop()
      clearFrameStreamQueue()
      hideFrameStreamCanvas()
      restoreFrameStreamVisualState()
      frameStreamDone = false
      frameStreamTotalFrames = 0
      frameStreamDroppedFrames = 0
      frameStreamFirstFrameAtMs = 0
      frameStreamStartAtMs = 0
      frameStreamNextPresentIndex = 0
      frameStreamRenderedPresentIndex = -1
    }
    // First chunk: enter (or resume) streaming mode.
    // Also handles the inGapIdle case: gap-idle is showing and the next task's first
    // chunk has just arrived.
    const wasInGapIdle = inGapIdle
    inGapIdle = false
    gapIdlePreloaded = false
    mode = 'streaming'
    chunkQueue = []
    reportStreamQueueState(true)
    standbyReady = false
    standbyLoading = false
    standbyLoadMode = null
    idlePreloaded = false
    idleSeekTime = 0
    gapSeekTime = 0
    streamFrameCursor = 0
    nextChunkPlaybackRate = 1
    activeChunkFrames = 0
    activeChunkStartedAtMs = 0
    awaitingAudioGate = false
    awaitingDurationGate = false
    // Hard-reset audio clock for every new streaming task to prevent stale currentTime
    // from the previous sentence causing boundary jumps.
    stopStreamAudio()
    sentenceAudioPath = normalizedAudioPath || ''
    updateStatus('娴佸紡鎾斁 Streaming...')

    // Shrink camera to 1px (keep accessible for canvas drawImage)
    if (cameraMode) {
      cameraVideo.style.display = 'block'
      cameraVideo.style.width = '1px'
      cameraVideo.style.height = '1px'
      cameraVideo.style.position = 'fixed'
      cameraVideo.style.bottom = '0'
      cameraVideo.style.right = '0'
      cameraVideo.style.zIndex = '0'
    }

    if (!wasInGapIdle) {
      // Entering from true idle: freeze idle immediately (it's a static loop anyway).
      activeVideo.pause()
    }
    // From gap-idle: let it keep playing while the chunk loads 鈥?avoids a frozen frame.
    // We'll pause it just before the swap in the oncanplaythrough callback below.

    // Preload first chunk on standby.
    // Clear any lingering callbacks from previous gap-idle/idle preloads to prevent
    // zombie onseeked events calling swapVideos() at wrong times.
    const sb = getStandby()
    sb.oncanplaythrough = null
    sb.onseeked = null
    sb.onerror = null
    sb.src = pathToFileUrl(chunkPath)
    setVideoChunkFrames(sb, normalizedFrames)
    setVideoChunkAudio(sb, normalizedAudioPath)
    sb.muted = true
    const firstRate = normalizePlaybackRate(nextChunkPlaybackRate)
    sb.playbackRate = firstRate
    sb.defaultPlaybackRate = firstRate
    sb.preload = 'auto'
    sb.style.display = 'none'

    sb.oncanplaythrough = () => {
      sb.oncanplaythrough = null
      sb.onerror = null
      const expectedSrc = sb.currentSrc || sb.src
      startStreamAudio(normalizedAudioPath)
      void waitForAudioClockStart().then(() => {
        if (mode !== 'streaming') return
        const currentSrc = sb.currentSrc || sb.src
        if (currentSrc !== expectedSrc) return
        if (wasInGapIdle) {
          // Pause gap-idle at the last possible moment 鈥?right before swapping.
          // This keeps the body moving with zero frozen-frame gap.
          activeVideo.pause()
        }
        swapVideos()
        isPlaying = true
        console.log('[FrameSync] First chunk ready, swapped from frozen idle')
        preloadNextChunk()
      })
    }

    sb.onerror = () => {
      sb.onerror = null
      sb.oncanplaythrough = null
      console.error('First chunk load failed:', chunkPath)
      exitStreamingMode()
    }
    return
  }

  // Subsequent chunks: queue and preload.
  // A new chunk arriving means any pending gap-idle state from the previous task is
  // now stale 鈥?cancel it immediately so it cannot cut off the current task mid-sentence.
  chunkQueue.push({ path: chunkPath, nFrames: normalizedFrames, audioPath: normalizedAudioPath })
  reportStreamQueueState()
  gapSeekTime = 0
  gapIdlePreloaded = false

  // If standby is currently loading a gap-idle video, abort it NOW by clearing its
  // callbacks. This prevents the async onseeked from later resurrecting gapIdlePreloaded=true
  // (the "zombie" state that was cutting speech off mid-sentence).
  if (standbyLoadMode === 'gap-idle') {
    const sb = getStandby()
    sb.oncanplaythrough = null
    sb.onseeked = null
    sb.onerror = null
    standbyLoading = false
    standbyLoadMode = null
    console.log('[GapIdle] Aborted in-flight gap-idle preload 鈥?chunk arrived')
  }

  updateStatus(`娴佸紡鎾斁 Streaming... (${chunkQueue.length} queued)`)

  if (!standbyReady && !standbyLoading) {
    preloadNextChunk()
  }
}

// Listen for commands from main process
window.playerApi.onPlaylist((paths: string[]) => {
  frameStreamDecodeToken += 1
  stopFrameStreamRenderLoop()
  clearFrameStreamQueue()
  hideFrameStreamCanvas()
  restoreFrameStreamVisualState()
  frameStreamDone = false
  frameStreamTotalFrames = 0
  frameStreamDroppedFrames = 0
  frameStreamFirstFrameAtMs = 0
  frameStreamStartAtMs = 0
  frameStreamNextPresentIndex = 0
  frameStreamRenderedPresentIndex = -1
  frameStreamBridgeHoldUntilMs = 0
  frameStreamBridgeEaseStartMs = 0
  frameStreamBridgeHoldDynamicMs = FRAME_STREAM_BRIDGE_HOLD_MS
  frameStreamLastAudioClockSec = 0
  frameStreamLastAudioClockAtMs = 0
  frameStreamAudioTimelineOffsetSec = 0
  frameStreamJunction = null
  pendingFrameSegment = null
  frameStreamAppendMode = false
  frameStreamAudioQueue = []
  chunkQueue = []
  mode = 'idle'
  reportStreamQueueState(true)
  playlist = paths
  currentIndex = 0
  if (paths.length > 0) {
    playCurrent()
  }
})

window.playerApi.onPlayVideo((path: string) => {
  frameStreamDecodeToken += 1
  stopFrameStreamRenderLoop()
  clearFrameStreamQueue()
  hideFrameStreamCanvas()
  restoreFrameStreamVisualState()
  frameStreamDone = false
  frameStreamTotalFrames = 0
  frameStreamDroppedFrames = 0
  frameStreamFirstFrameAtMs = 0
  frameStreamStartAtMs = 0
  frameStreamNextPresentIndex = 0
  frameStreamRenderedPresentIndex = -1
  frameStreamBridgeHoldUntilMs = 0
  frameStreamBridgeEaseStartMs = 0
  frameStreamBridgeHoldDynamicMs = FRAME_STREAM_BRIDGE_HOLD_MS
  frameStreamLastAudioClockSec = 0
  frameStreamLastAudioClockAtMs = 0
  frameStreamAudioTimelineOffsetSec = 0
  frameStreamJunction = null
  pendingFrameSegment = null
  chunkQueue = []
  mode = 'idle'
  reportStreamQueueState(true)
  playlist = [path]
  currentIndex = 0
  playCurrent()
})

// F2F result video - switch to active mode (legacy)
window.playerApi.onPlayResult((path: string) => {
  playResult(path)
})

// Streaming chunk - switch to streaming mode
window.playerApi.onPlayChunk((path: string, streamAudioPath?: string | null, chunkFrames?: number | null) => {
  playChunk(path, streamAudioPath, chunkFrames)
})

// Frame-batch streaming - continuous idle + mouth overlay
window.playerApi.onPlayFrameBatch((batch: FrameBatchPayload) => {
  handleFrameBatch(batch)
})

window.playerApi.onFrameStreamDone(() => {
  if (STRICT_APPEND_FRAME_STREAM) return
  if (mode === 'frame-streaming') {
    frameStreamDone = true
  }
})

window.playerApi.onStop(() => {
  frameStreamDecodeToken += 1
  stopStreamAudio()
  stopFrameStreamRenderLoop()
  clearFrameStreamQueue()
  hideFrameStreamCanvas()
  restoreFrameStreamVisualState()
  frameStreamDone = false
  frameStreamTotalFrames = 0
  frameStreamDroppedFrames = 0
  frameStreamFirstFrameAtMs = 0
  frameStreamStartAtMs = 0
  frameStreamNextPresentIndex = 0
  frameStreamRenderedPresentIndex = -1
  frameStreamBridgeHoldUntilMs = 0
  frameStreamBridgeEaseStartMs = 0
  frameStreamBridgeHoldDynamicMs = FRAME_STREAM_BRIDGE_HOLD_MS
  frameStreamLastAudioClockSec = 0
  frameStreamLastAudioClockAtMs = 0
  frameStreamAudioTimelineOffsetSec = 0
  frameStreamJunction = null
  pendingFrameSegment = null
  frameStreamAppendMode = false
  frameStreamAudioQueue = []
  sentenceAudioPath = ''
  disableCamera()
  videoA.pause()
  videoA.removeAttribute('src')
  videoA.load()
  videoB.pause()
  videoB.removeAttribute('src')
  videoB.load()
  isPlaying = false
  playlist = []
  resultQueue = []
  chunkQueue = []
  mode = 'idle'
  reportStreamQueueState(true)
  standbyReady = false
  standbyLoading = false
  standbyLoadMode = null
  idlePreloaded = false
  idleSeekTime = 0
  gapSeekTime = 0
  inGapIdle = false
  gapIdlePreloaded = false
  activeChunkFrames = 0
  activeChunkStartedAtMs = 0
  streamFrameCursor = 0
  nextChunkPlaybackRate = 1
  awaitingAudioGate = false
  awaitingDurationGate = false
  updateStatus('宸插仠姝?Stopped')
})

window.playerApi.onSetVolume((vol: number) => {
  const v = Math.max(0, Math.min(1, vol))
  streamVolume = v
  videoA.volume = v
  videoB.volume = v
  if (streamAudio) streamAudio.volume = v
  // Don't change muted state here 鈥?idle videos stay muted,
  // chunks/results unmute themselves when they start playing
})

// =====================================================================
// Chroma Key (Green Screen Removal) 鈥?Canvas 2D
// =====================================================================

const chromaCanvas = document.getElementById('chromaCanvas') as HTMLCanvasElement
let chromaEnabled = false
let chromaThreshold = 0.26
let chromaBlend = 0.10
let chromaCtx: CanvasRenderingContext2D | null = null
let chromaWorkCanvas: HTMLCanvasElement | null = null
let chromaWorkCtx: CanvasRenderingContext2D | null = null
let chromaRafId = 0
let chromaFrameCount = 0
let chromaErrorLogged = false
let chromaWaitLogged = false
let chromaLastRenderMs = 0
const chromaIdleTargetFps = 22
const chromaStreamTargetFps = streamClockFps
const chromaIdleWorkScale = 0.5
const chromaStreamWorkScale = 0.65

// Sampled green screen color (auto-detected from edges)
let chromaKeyR = 0, chromaKeyG = 200, chromaKeyB = 0
let chromaKeySampled = false

function sampleGreenScreenColor(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  // Sample pixels from all 4 edges (corners + midpoints) to find the green screen color
  const samplePoints: [number, number][] = [
    // Corners (inset by 5px)
    [5, 5], [w - 5, 5], [5, h - 5], [w - 5, h - 5],
    // Edge midpoints
    [Math.floor(w / 2), 5], [Math.floor(w / 2), h - 5],
    [5, Math.floor(h / 2)], [w - 5, Math.floor(h / 2)],
    // Quarter points on edges
    [Math.floor(w / 4), 5], [Math.floor(w * 3 / 4), 5],
    [Math.floor(w / 4), h - 5], [Math.floor(w * 3 / 4), h - 5],
  ]

  const colors: { r: number; g: number; b: number }[] = []
  for (const [x, y] of samplePoints) {
    const px = ctx.getImageData(x, y, 1, 1).data
    colors.push({ r: px[0], g: px[1], b: px[2] })
  }

  // Log all sampled colors
  console.warn('[Chroma] Edge samples:', colors.map((c, i) =>
    `(${samplePoints[i][0]},${samplePoints[i][1]})=rgb(${c.r},${c.g},${c.b})`).join(' '))

  // Find the most common "greenish" color 鈥?filter for pixels where G is dominant
  const greenish = colors.filter(c => c.g > c.r && c.g > c.b && c.g > 50)

  if (greenish.length >= 3) {
    // Average the greenish colors
    const avg = greenish.reduce((a, c) => ({ r: a.r + c.r, g: a.g + c.g, b: a.b + c.b }),
      { r: 0, g: 0, b: 0 })
    chromaKeyR = Math.round(avg.r / greenish.length)
    chromaKeyG = Math.round(avg.g / greenish.length)
    chromaKeyB = Math.round(avg.b / greenish.length)
    chromaKeySampled = true
    console.warn(`[Chroma] Auto-detected green screen color: rgb(${chromaKeyR},${chromaKeyG},${chromaKeyB}) from ${greenish.length} samples`)
  } else {
    // Fallback: just use the most common edge color
    console.warn('[Chroma] Not enough greenish samples (' + greenish.length + '), using all edge avg')
    const avg = colors.reduce((a, c) => ({ r: a.r + c.r, g: a.g + c.g, b: a.b + c.b }),
      { r: 0, g: 0, b: 0 })
    chromaKeyR = Math.round(avg.r / colors.length)
    chromaKeyG = Math.round(avg.g / colors.length)
    chromaKeyB = Math.round(avg.b / colors.length)
    chromaKeySampled = true
    console.warn(`[Chroma] Fallback edge color: rgb(${chromaKeyR},${chromaKeyG},${chromaKeyB})`)
  }
}

function renderChromaFrame(): void {
  if (!chromaEnabled || !chromaCtx) return

  const useFrameStream = mode === 'frame-streaming' && frameStreamCanvas.style.display !== 'none'
  const source: HTMLVideoElement | HTMLCanvasElement = useFrameStream
    ? frameStreamCanvas
    : (cameraMode && mode !== 'streaming' && mode !== 'active' && mode !== 'frame-streaming')
      ? cameraVideo
      : activeVideo
  const sourcePaused = source instanceof HTMLVideoElement ? source.paused : false
  const sourceReady = source instanceof HTMLVideoElement ? source.readyState >= 2 : true
  if (!sourceReady || sourcePaused) {
    if (!chromaWaitLogged) {
      const srcInfo = source instanceof HTMLVideoElement ? (source.src || 'none').slice(-30) : 'frameCanvas'
      console.warn('[Chroma] Waiting for video: paused=' + sourcePaused +
        ' readyState=' + (source instanceof HTMLVideoElement ? source.readyState : 4) + ' src=' + srcInfo)
      chromaWaitLogged = true
    }
    chromaRafId = requestAnimationFrame(renderChromaFrame)
    return
  }

  if (chromaWaitLogged && chromaFrameCount === 0) {
    console.warn('[Chroma] Video ready, starting render')
  }

  // Canvas chroma at full HD is expensive; throttle to source FPS to reduce stutter.
  const now = performance.now()
  const targetFps =
    mode === 'streaming' || mode === 'active' || mode === 'frame-streaming'
      ? chromaStreamTargetFps
      : chromaIdleTargetFps
  const minIntervalMs = 1000 / targetFps
  if (chromaLastRenderMs > 0 && now - chromaLastRenderMs < minIntervalMs - 1) {
    chromaRafId = requestAnimationFrame(renderChromaFrame)
    return
  }
  chromaLastRenderMs = now

  try {
    const vw = source instanceof HTMLVideoElement ? source.videoWidth || 1 : source.width || 1
    const vh = source instanceof HTMLVideoElement ? source.videoHeight || 1 : source.height || 1
    const workScale =
      mode === 'streaming' || mode === 'active' || mode === 'frame-streaming'
        ? chromaStreamWorkScale
        : chromaIdleWorkScale
    const sw = Math.max(2, Math.round(vw * workScale))
    const sh = Math.max(2, Math.round(vh * workScale))

    if (chromaCanvas.width !== vw || chromaCanvas.height !== vh) {
      chromaCanvas.width = vw
      chromaCanvas.height = vh
      console.warn(`[Chroma] Canvas resized to ${vw}x${vh}`)
    }
    if (chromaWorkCanvas && (chromaWorkCanvas.width !== sw || chromaWorkCanvas.height !== sh)) {
      chromaWorkCanvas.width = sw
      chromaWorkCanvas.height = sh
      console.warn(`[Chroma] Work canvas resized to ${sw}x${sh}`)
    }

    if (!chromaWorkCtx || !chromaWorkCanvas) {
      chromaCtx.drawImage(source, 0, 0, vw, vh)
      chromaRafId = requestAnimationFrame(renderChromaFrame)
      return
    }

    // Draw video frame to low-res work canvas
    chromaWorkCtx.drawImage(source, 0, 0, sw, sh)

    // On first valid frame, sample edge colors to detect green screen
    if (!chromaKeySampled && chromaFrameCount === 0) {
      sampleGreenScreenColor(chromaWorkCtx, sw, sh)
    }

    // Chroma key: compare each pixel to the sampled key color using color distance
    if (chromaKeySampled) {
      const imageData = chromaWorkCtx.getImageData(0, 0, sw, sh)
      const d = imageData.data
      // similarity (0-100): higher similarity => stricter (smaller color distance).
      // Keep the distance positive to avoid invalid ranges that can erase the whole frame.
      const similarity = Math.max(0, Math.min(1, chromaThreshold))
      const coreDist = 18 + (1 - similarity) * 112
      // smoothing: larger value => softer edge transition.
      const blendRange = 8 + Math.max(0, chromaBlend) * 140
      const kr = chromaKeyR, kg = chromaKeyG, kb = chromaKeyB
      const coreDistSq = coreDist * coreDist
      const outerDist = coreDist + Math.max(2, blendRange)
      const outerDistSq = outerDist * outerDist

      if (chromaFrameCount === 0) {
        console.warn(`[Chroma] coreDist=${coreDist.toFixed(1)} blendRange=${blendRange.toFixed(1)} keyColor=rgb(${kr},${kg},${kb})`)
      }

      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2]
        const dr = r - kr, dg = g - kg, db = b - kb
        const distSq = dr * dr + dg * dg + db * db

        if (distSq < coreDistSq) {
          // Fully matched 鈫?transparent
          d[i] = 0
          d[i + 1] = 0
          d[i + 2] = 0
          d[i + 3] = 0
        } else if (distSq < outerDistSq) {
          // Edge blend with smoothstep curve for natural transition
          const dist = Math.sqrt(distSq)
          const linear = (dist - coreDist) / blendRange // 0..1
          // Smoothstep: 3t虏 - 2t鲁 鈥?smoother than linear
          const t = linear * linear * (3 - 2 * linear)
          const alpha = Math.round(255 * t)
          // Despill: suppress green spill on edge pixels
          const despilledG = Math.min(g, (r + b) * 0.5)
          // Premultiplied alpha
          d[i] = Math.round(r * t)
          d[i + 1] = Math.round(despilledG * t)
          d[i + 2] = Math.round(b * t)
          d[i + 3] = alpha
        } else {
          // Keep original but despill green fringe on near-edge pixels
          const greenExcess = g - (r + b) * 0.5
          if (greenExcess > 10) {
            // Mild despill for pixels near the green screen
            const despillStr = Math.min(greenExcess * 0.3, 30)
            d[i + 1] = Math.round(g - despillStr)
          }
        }
      }

      chromaWorkCtx.putImageData(imageData, 0, 0)
      chromaCtx.clearRect(0, 0, vw, vh)
      chromaCtx.imageSmoothingEnabled = true
      chromaCtx.drawImage(chromaWorkCanvas, 0, 0, vw, vh)
    } else {
      chromaCtx.clearRect(0, 0, vw, vh)
      chromaCtx.imageSmoothingEnabled = true
      chromaCtx.drawImage(chromaWorkCanvas, 0, 0, vw, vh)
    }

    chromaFrameCount++
    if (chromaFrameCount === 1) {
      console.warn('[Chroma] First frame rendered OK, video=' + vw + 'x' + vh)
    } else if (chromaFrameCount % 1800 === 0) {
      console.warn('[Chroma] Rendered ' + chromaFrameCount + ' frames')
    }
  } catch (err: any) {
    if (!chromaErrorLogged) {
      console.error('[Chroma] renderChromaFrame error:', err.message || err)
      chromaErrorLogged = true
    }
  }

  chromaRafId = requestAnimationFrame(renderChromaFrame)
}

function enableChroma(): void {
  // Allow re-enabling to update visual state
  if (!chromaCtx) {
    chromaCtx = chromaCanvas.getContext('2d', { willReadFrequently: true })
    if (!chromaCtx) {
      console.warn('[Chroma] Canvas 2D context failed!')
      chromaEnabled = false
      return
    }
  }
  if (!chromaWorkCanvas) chromaWorkCanvas = document.createElement('canvas')
  if (!chromaWorkCtx && chromaWorkCanvas) {
    chromaWorkCtx = chromaWorkCanvas.getContext('2d', { willReadFrequently: true })
  }

  const wasEnabled = chromaEnabled
  chromaEnabled = true
  chromaFrameCount = 0
  chromaErrorLogged = false
  chromaWaitLogged = false
  chromaLastRenderMs = 0
  chromaKeySampled = false // re-sample green on next frame

  console.warn('[Chroma] ENABLED (threshold=' + chromaThreshold + ', blend=' + chromaBlend + ')')

  // Shrink videos to 1x1px so hardware overlay is negligible, but drawImage still decodes frames.
  // display:none stops decoding; off-screen stops drawImage; 1x1px is the workaround.
  videoA.style.width = '1px'
  videoA.style.height = '1px'
  videoA.style.position = 'fixed'
  videoA.style.bottom = '0'
  videoA.style.right = '0'
  videoA.style.zIndex = '1'
  videoB.style.width = '1px'
  videoB.style.height = '1px'
  videoB.style.position = 'fixed'
  videoB.style.bottom = '0'
  videoB.style.right = '0'
  videoB.style.zIndex = '1'

  // Show canvas as the sole visible element
  chromaCanvas.style.position = 'fixed'
  chromaCanvas.style.top = '0'
  chromaCanvas.style.left = '0'
  chromaCanvas.style.width = '100vw'
  chromaCanvas.style.height = '100vh'
  chromaCanvas.style.display = 'block'
  chromaCanvas.style.zIndex = '9999'
  chromaCanvas.style.background = 'transparent'
  document.body.style.background = 'transparent'
  document.documentElement.style.background = 'transparent'

  // Only start a new render loop if not already running
  if (!wasEnabled) {
    chromaRafId = requestAnimationFrame(renderChromaFrame)
  }
}

function disableChroma(): void {
  const wasEnabled = chromaEnabled
  chromaEnabled = false
  chromaLastRenderMs = 0

  if (chromaRafId) {
    cancelAnimationFrame(chromaRafId)
    chromaRafId = 0
  }

  console.warn('[Chroma] DISABLED (wasEnabled=' + wasEnabled + ')')

  // Hide canvas, restore to original state
  chromaCanvas.style.display = 'none'
  chromaCanvas.style.position = 'absolute'
  chromaCanvas.style.top = '0'
  chromaCanvas.style.left = '0'
  chromaCanvas.style.width = '100%'
  chromaCanvas.style.height = '100%'
  chromaCanvas.style.zIndex = '3'
  chromaCanvas.style.background = 'transparent'

  // Restore video elements to full size
  videoA.style.width = '100%'
  videoA.style.height = '100%'
  videoA.style.position = 'absolute'
  videoA.style.left = '0'
  videoA.style.top = '0'
  videoA.style.bottom = ''
  videoA.style.right = ''
  videoA.style.display = activeVideo === videoA ? 'block' : 'none'
  videoA.style.zIndex = '2'
  videoA.style.opacity = mode === 'frame-streaming' ? '0' : '1'
  videoB.style.width = '100%'
  videoB.style.height = '100%'
  videoB.style.position = 'absolute'
  videoB.style.left = '0'
  videoB.style.top = '0'
  videoB.style.bottom = ''
  videoB.style.right = ''
  videoB.style.display = activeVideo === videoB ? 'block' : 'none'
  videoB.style.zIndex = '1'
  videoB.style.opacity = mode === 'frame-streaming' ? '0' : '1'

  document.body.style.background = '#000'
  document.documentElement.style.background = '#000'
}

window.playerApi.onSetChroma((settings) => {
  console.warn('[Chroma] Received:', JSON.stringify(settings))
  // Store raw values: similarity 0-100, smoothing 0-10
  chromaThreshold = settings.similarity / 100   // 0.0 - 1.0
  chromaBlend = settings.smoothing / 10          // 0.0 - 1.0

  if (settings.enabled) {
    enableChroma()
    updateStatus('鎶犵豢骞曞凡寮€鍚?Chroma ON')
  } else {
    disableChroma()
    updateStatus('鎶犵豢骞曞凡鍏抽棴 Chroma OFF')
  }
})

// Press G on player window: diagnostic 鈥?fill canvas with solid RED to verify canvas visibility
// Press H on player window: toggle chroma effect
document.addEventListener('keydown', (e) => {
  if (e.key === 'g' || e.key === 'G') {
    // DIAGNOSTIC: remove diagnostic div if present
    const existing = document.getElementById('chromaDiag')
    if (existing) {
      existing.remove()
      console.warn('[Chroma] G pressed: removed diagnostic div')
      return
    }
  }
  if (e.key === 'h' || e.key === 'H') {
    console.warn('[Chroma] H key pressed, chromaEnabled=' + chromaEnabled)
    if (chromaEnabled) {
      disableChroma()
    } else {
      enableChroma()
    }
  }
})

// Frame sync: respond to position queries from main process
// Do NOT freeze 鈥?idle continues playing, pipeline predicts the delay
window.playerApi.onQueryPosition((nonce: string) => {
  // Camera mode idle: no idle video, return 0 so pipeline uses default start_frame
  if (cameraMode && mode !== 'streaming' && mode !== 'frame-streaming') {
    window.playerApi.respondPosition(nonce, { currentTime: 0, duration: 0 })
    return
  }
  window.playerApi.respondPosition(nonce, {
    currentTime: activeVideo.currentTime,
    duration: activeVideo.duration || 0
  })
})

// Frame sync: set idle seek time for seamless resume after streaming
window.playerApi.onSetIdleSeek((seekTime: number) => {
  idleSeekTime = seekTime
  console.log(`[IDLE-SEEK] idleSeekTime=${seekTime.toFixed(3)}s mode=${mode} chunkQ=${chunkQueue.length} sbLoading=${standbyLoading} sbReady=${standbyReady} gapIdlePreloaded=${gapIdlePreloaded}`)
  // If standby is free and no chunks queued, start preloading idle now
  if (mode === 'streaming' && chunkQueue.length === 0 && !standbyLoading && !standbyReady && !idlePreloaded) {
    preloadIdleVideo()
  }
})

// Gap-idle: store the idle-video position to show during inter-task gaps
window.playerApi.onSetGapSeek((seekTime: number) => {
  gapSeekTime = seekTime
  gapIdlePreloaded = false  // discard any stale pre-load from a previous task

  // If a gap-idle preload for a previous (now stale) seekTime is still in flight,
  // abort it so its onseeked callback cannot resurrect gapIdlePreloaded=true.
  if (standbyLoadMode === 'gap-idle') {
    const sb = getStandby()
    sb.oncanplaythrough = null
    sb.onseeked = null
    sb.onerror = null
    standbyLoading = false
    standbyLoadMode = null
    console.log('[GapIdle] Aborted stale in-flight preload (new gapSeekTime received)')
  }

  console.log(`[GAP-SEEK] gapSeekTime=${seekTime.toFixed(3)}s mode=${mode} chunkQ=${chunkQueue.length} sbLoading=${standbyLoading} sbReady=${standbyReady} gapIdlePreloaded=${gapIdlePreloaded}`)
  // If the last chunk is already playing and standby is now free, start pre-loading.
  // (Handles the case where gapSeekTime arrives after the last chunk has begun.)
  if (mode === 'streaming' && chunkQueue.length === 0
      && !standbyLoading && !standbyReady && !idlePreloaded) {
    preloadGapIdleVideo()
  }
})

// Camera mode IPC
window.playerApi.onEnableCamera((deviceId: string, profileId: string) => {
  enableCamera(deviceId, profileId).catch(err => {
    console.error('[Camera] Enable failed:', err)
    updateStatus('鎽勫儚澶存墦寮€澶辫触')
  })
})

window.playerApi.onDisableCamera(() => {
  disableCamera()
})

// Signal ready
window.playerApi.playerReady()
reportStreamQueueState(true)
updateStatus('绛夊緟鎾斁... Waiting...')

export type {} // make this file a module so declare global works

declare global {
  interface Window {
    playerApi: {
      closePlayer: () => void
      toggleAlwaysOnTop: () => void
      playerReady: () => void
      resultFinished: () => void
      chunkPlayed: () => void
      frameAudioEnded: (audioPath?: string) => void
      setStreamAudioState: (playing: boolean) => void
      setStreamQueueState: (depth: number, mode?: string) => void
      onPlaylist: (callback: (paths: string[]) => void) => void
      onPlayVideo: (callback: (path: string) => void) => void
      onPlayResult: (callback: (path: string) => void) => void
      onPlayChunk: (
        callback: (path: string, streamAudioPath?: string | null, chunkFrames?: number | null) => void
      ) => void
      onPlayFrameBatch: (
        callback: (batch: {
          codec: 'jpeg'
          fps: number
          width: number
          height: number
          startFrame: number
          frameIndices: number[]
          frames: string[]
          totalFrames?: number
          audioPath?: string
        }) => void
      ) => void
      onFrameStreamDone: (callback: () => void) => void
      onStop: (callback: () => void) => void
      onSetVolume: (callback: (vol: number) => void) => void
      onSetChroma: (
        callback: (settings: { enabled: boolean; similarity: number; smoothing: number }) => void
      ) => void
      onQueryPosition: (callback: (nonce: string) => void) => void
      respondPosition: (nonce: string, data: { currentTime: number; duration: number }) => void
      onSetIdleSeek: (callback: (seekTime: number) => void) => void
      onSetGapSeek: (callback: (seekTime: number) => void) => void
      // Camera mode
      onEnableCamera: (callback: (deviceId: string, profileId: string) => void) => void
      onDisableCamera: (callback: () => void) => void
      sendCameraCapture: (profileId: string, buffer: ArrayBuffer) => Promise<any>
      cameraCaptureReady: (filePath: string) => void
    }
  }
}
