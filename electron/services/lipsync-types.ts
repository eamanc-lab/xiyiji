export interface ChunkInfo {
  chunkIdx: number
  totalChunks: number
  path: string
  nFrames: number
  audioPath?: string
}

export interface FrameBatchInfo {
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
