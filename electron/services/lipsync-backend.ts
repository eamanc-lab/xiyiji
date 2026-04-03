/**
 * Lip-sync backend abstraction layer.
 *
 * Defines a common interface so the pipeline can work with any
 * lip-sync engine without knowing the concrete implementation.
 */

import type { ChunkInfo, FrameBatchInfo } from './lipsync-types'

export interface LipSyncBackend {
  /** Backend identifier */
  readonly name: string

  /**
   * Submit a lip-sync task (legacy batch mode).
   * @param videoPath - Host path to avatar video
   * @param audioPath - Host path to audio file
   * @param instanceIdx - Optional instance index for multi-container setups
   * @returns Object containing the task_id
   */
  submit(
    videoPath: string,
    audioPath: string,
    instanceIdx?: number
  ): Promise<{ task_id: string }>

  /**
   * Query task status (legacy batch mode).
   * @param taskId - The task identifier returned by submit()
   * @param instanceIdx - Optional instance index
   * @returns Task status, progress, result path, and error info
   */
  query(
    taskId: string,
    instanceIdx?: number
  ): Promise<{
    status: string
    progress: number
    result_path?: string
    error?: string
  }>

  /** Probe which instances are running and reachable. */
  probeInstances(): Promise<number[]>

  /** Check if at least one instance is available. */
  isAvailable(): Promise<boolean>

  /** Get total number of configured instances. */
  getInstanceCount(): number

  /**
   * Initialize avatar for streaming mode (optional).
   * Loads video and performs face detection; results cached per video path.
   */
  initAvatar?(videoPath: string): Promise<void>

  /**
   * Process audio in streaming mode (optional).
   * Calls onChunk for each video chunk as it becomes available.
   * @param onAck - Called after feature extraction with frame/chunk counts; returns start_frame for seamless transition
   */
  processAudioStream?(
    audioPath: string,
    onChunk?: (chunk: ChunkInfo) => void,
    onAck?: (numFrames: number, totalChunks: number) => Promise<number>,
    onFrameBatch?: (batch: FrameBatchInfo) => void
  ): Promise<{ totalChunks: number; totalFrames: number; endFrame?: number }>

  /** Get avatar video metadata after initAvatar (optional). */
  getAvatarInfo?(): { fps: number; nFrames: number; cropRegion?: { x: number; y: number; w: number; h: number } } | null

  /** Streaming transport mode exposed by backend (optional). */
  getStreamingTransport?(): 'chunk' | 'frame_batch'

  /** Returns true if an append stream session is already active (optional). */
  hasActiveAppendStream?(): boolean

  /**
   * Reset only the streaming session state (e.g. close append stream) without
   * fully tearing down the backend process.
   */
  resetStreamingSession?(): void

  /** Gracefully shut down the backend (optional). */
  shutdown?(reason?: string, opts?: { force?: boolean }): void

  /** Inject a live camera frame (JPEG base64) into the inference pipeline (optional). */
  injectCameraFrame?(jpegBase64: string): void

  /** Tell the backend the path to the shared camera frame file (optional). */
  setCameraFramePath?(path: string): void

  /** Clear live camera frame injection (optional). */
  clearCameraFrame?(): void

  /** Start real-time face tracking for camera mode (optional). */
  startFaceTracking?(framePath: string): void

  /** Stop real-time face tracking (optional). */
  stopFaceTracking?(): void
}

export type BackendType = 'yundingyunbo' | 'yundingyunbo_video_stream'

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const registry = new Map<BackendType, LipSyncBackend>()
let activeBackend: LipSyncBackend | null = null
let activeBackendType: BackendType | null = null

export function registerBackend(type: BackendType, backend: LipSyncBackend): void {
  registry.set(type, backend)
  console.log(`[LipSync] Registered backend: ${type}`)
}

export function setActiveBackend(type: BackendType): void {
  const backend = registry.get(type)
  if (!backend) {
    throw new Error(`[LipSync] Unknown backend: ${type}. Registered: ${[...registry.keys()].join(', ')}`)
  }
  activeBackend = backend
  activeBackendType = type
  console.log(`[LipSync] Active backend set to: ${type}`)
}

export function getActiveBackend(): LipSyncBackend {
  if (!activeBackend) {
    throw new Error('[LipSync] No active backend. Call initLipSyncBackends() first.')
  }
  return activeBackend
}

export function getBackend(type: BackendType): LipSyncBackend | undefined {
  return registry.get(type)
}

export function getActiveBackendType(): BackendType | null {
  return activeBackendType
}

export function isNativeRendererBackendType(type: BackendType | null | undefined): boolean {
  return type === 'yundingyunbo' || type === 'yundingyunbo_video_stream'
}

export function getRegisteredBackends(): BackendType[] {
  return [...registry.keys()]
}
