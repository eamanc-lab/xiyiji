import { contextBridge, ipcRenderer } from 'electron'

const playerApi = {
  closePlayer: () => ipcRenderer.invoke('player:close'),
  toggleAlwaysOnTop: () => ipcRenderer.invoke('player:toggle-ontop'),
  playerReady: () => ipcRenderer.send('player:ready'),
  resultFinished: () => ipcRenderer.send('player:result-finished'),
  chunkPlayed: () => ipcRenderer.send('player:chunk-played'),
  frameAudioEnded: (audioPath?: string) =>
    ipcRenderer.send(
      'player:frame-audio-ended',
      typeof audioPath === 'string' ? audioPath : '',
      Date.now()
    ),
  setStreamAudioState: (playing: boolean) =>
    ipcRenderer.send('player:stream-audio-state', !!playing, Date.now()),
  setStreamQueueState: (depth: number, mode?: string) =>
    ipcRenderer.send(
      'player:stream-queue-state',
      Math.max(0, Math.floor(Number.isFinite(depth) ? depth : 0)),
      typeof mode === 'string' ? mode : '',
      Date.now()
    ),

  onPlaylist: (callback: (paths: string[]) => void) => {
    ipcRenderer.on('player:playlist', (_event, paths) => callback(paths))
  },
  onPlayVideo: (callback: (path: string) => void) => {
    ipcRenderer.on('player:play-video', (_event, path) => callback(path))
  },
  onPlayResult: (callback: (path: string) => void) => {
    ipcRenderer.on('player:play-result', (_event, path) => callback(path))
  },
  onPlayChunk: (callback: (path: string, streamAudioPath?: string | null, chunkFrames?: number | null) => void) => {
    ipcRenderer.on('player:play-chunk', (_event, path, streamAudioPath, chunkFrames) =>
      callback(path, streamAudioPath ?? null, typeof chunkFrames === 'number' ? chunkFrames : null)
    )
  },
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
  ) => {
    ipcRenderer.on('player:play-frame-batch', (_event, batch) => callback(batch))
  },
  onFrameStreamDone: (callback: () => void) => {
    ipcRenderer.on('player:frame-stream-done', () => callback())
  },
  onStop: (callback: () => void) => {
    ipcRenderer.on('player:stop', () => callback())
  },
  onSetVolume: (callback: (vol: number) => void) => {
    ipcRenderer.on('player:set-volume', (_event, vol) => callback(vol))
  },
  onSetChroma: (callback: (settings: { enabled: boolean; similarity: number; smoothing: number }) => void) => {
    ipcRenderer.on('player:set-chroma', (_event, settings) => callback(settings))
  },
  onQueryPosition: (callback: (nonce: string) => void) => {
    ipcRenderer.on('player:query-position', (_event, nonce) => callback(nonce))
  },
  respondPosition: (nonce: string, data: { currentTime: number; duration: number }) => {
    ipcRenderer.send(`player:position-response:${nonce}`, data)
  },
  onSetIdleSeek: (callback: (seekTime: number) => void) => {
    ipcRenderer.on('player:set-idle-seek', (_event, t) => callback(t))
  },
  onSetGapSeek: (callback: (seekTime: number) => void) => {
    ipcRenderer.on('player:set-gap-seek', (_event, t) => callback(t))
  },

  // Camera mode
  onEnableCamera: (callback: (deviceId: string, profileId: string) => void) => {
    ipcRenderer.on('player:enable-camera', (_event, deviceId, profileId) => callback(deviceId, profileId))
  },
  onDisableCamera: (callback: () => void) => {
    ipcRenderer.on('player:disable-camera', () => callback())
  },
  sendCameraCapture: (profileId: string, buffer: ArrayBuffer) =>
    ipcRenderer.invoke('camera:record-save', profileId, buffer),
  cameraCaptureReady: (filePath: string) =>
    ipcRenderer.send('player:camera-capture-ready', filePath),
  // Live camera frame injection — sends JPEG base64 to F2F engine for real-time lip sync
  injectCameraFrame: (jpegBase64: string) =>
    ipcRenderer.send('player:inject-camera-frame', jpegBase64),
  clearCameraFrame: () =>
    ipcRenderer.send('player:clear-camera-frame')
}

contextBridge.exposeInMainWorld('playerApi', playerApi)
