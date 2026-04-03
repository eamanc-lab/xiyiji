declare global {
  interface Window {
    playerApi: {
      closePlayer: () => void
      toggleAlwaysOnTop: () => void
      playerReady: () => void
      resultFinished: () => void
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
      chunkPlayed: () => void
      // Live camera frame injection
      injectCameraFrame: (jpegBase64: string) => void
      clearCameraFrame: () => void
    }
  }
}
