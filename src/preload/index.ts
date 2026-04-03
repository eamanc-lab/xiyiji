import { contextBridge, ipcRenderer } from 'electron'

const api = {
  // ── Window controls ───────────────────────────────────────────────────────
  windowMinimize: () => ipcRenderer.invoke('window:minimize'),
  windowMaximize: () => ipcRenderer.invoke('window:maximize'),
  windowClose: () => ipcRenderer.invoke('window:close'),
  windowIsMaximized: () => ipcRenderer.invoke('window:isMaximized'),

  // ── Docker management ─────────────────────────────────────────────────────
  dockerStatus: () => ipcRenderer.invoke('docker:status'),
  dockerStart: (containerName?: string) => ipcRenderer.invoke('docker:start', containerName),
  dockerStop: (containerName?: string) => ipcRenderer.invoke('docker:stop', containerName),
  dockerRestart: (containerName: string) => ipcRenderer.invoke('docker:restart', containerName),
  dockerLogs: (containerName: string, lines: number) =>
    ipcRenderer.invoke('docker:logs', containerName, lines),

  // ── File system ───────────────────────────────────────────────────────────
  selectVideoFile: () => ipcRenderer.invoke('file:select-video'),
  selectAudioFile: () => ipcRenderer.invoke('file:select-audio'),
  selectImageFile: () => ipcRenderer.invoke('file:select-image'),
  selectDirectory: () => ipcRenderer.invoke('file:select-dir'),
  getVideoInfo: (path: string) => ipcRenderer.invoke('file:get-video-info', path),
  fileExists: (path: string) => ipcRenderer.invoke('file:exists', path),
  saveFile: (defaultName: string) => ipcRenderer.invoke('file:save-dialog', defaultName),
  copyFile: (src: string, dest: string) => ipcRenderer.invoke('file:copy', src, dest),
  saveBlob: (buffer: ArrayBuffer, filename: string) =>
    ipcRenderer.invoke('file:save-blob', { buffer, filename }),
  selectVideoFiles: () => ipcRenderer.invoke('file:select-videos'),
  scanVideoDir: (dirPath: string) => ipcRenderer.invoke('file:scan-video-dir', dirPath),
  extractThumbnail: (videoPath: string, outputPath: string) =>
    ipcRenderer.invoke('file:extract-thumbnail', videoPath, outputPath),

  // ── Settings ──────────────────────────────────────────────────────────────
  settingsGet: (key: string) => ipcRenderer.invoke('settings:get', key),
  settingsSet: (key: string, value: string) => ipcRenderer.invoke('settings:set', key, value),
  settingsGetAll: () => ipcRenderer.invoke('settings:getAll'),

  // ── System info ───────────────────────────────────────────────────────────
  getSystemInfo: () => ipcRenderer.invoke('system:info'),
  getDiskSpace: (drive: string) => ipcRenderer.invoke('system:disk-space', drive),
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  getAppPath: () => ipcRenderer.invoke('app:path'),
  getUserDataPath: () => ipcRenderer.invoke('app:user-data-path'),
  logGetPath: () => ipcRenderer.invoke('log:get-path'),
  logOpenFolder: () => ipcRenderer.invoke('log:open-folder'),

  // 鈹€鈹€ App updater 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  updaterGetState: () => ipcRenderer.invoke('updater:get-state'),
  updaterCheck: (manifestUrl?: string) => ipcRenderer.invoke('updater:check', manifestUrl),
  updaterDownload: (manifestUrl?: string) => ipcRenderer.invoke('updater:download', manifestUrl),
  updaterApply: () => ipcRenderer.invoke('updater:apply'),
  updaterOpenFullPackage: () => ipcRenderer.invoke('updater:open-full-package'),
  updaterClearResult: () => ipcRenderer.invoke('updater:clear-result'),
  onUpdaterState: (callback: (state: any) => void) => {
    const handler = (_event: any, updaterState: any) => callback(updaterState)
    ipcRenderer.on('updater:state', handler)
    return () => ipcRenderer.removeListener('updater:state', handler)
  },

  // ── TTS ───────────────────────────────────────────────────────────────────
  ttsSynthesize: (text: string, voice: string, speed: number) =>
    ipcRenderer.invoke('tts:synthesize', text, voice, speed),
  ttsVoices: () => ipcRenderer.invoke('tts:voices'),
  ttsUploadVoice: (name: string, audioData: ArrayBuffer, filename?: string) =>
    ipcRenderer.invoke('tts:upload-voice', name, audioData, filename),
  ttsDeleteVoice: (voiceId: string) =>
    ipcRenderer.invoke('tts:delete-voice', voiceId),

  // ── Player window ─────────────────────────────────────────────────────────
  playerOpen: (paths: string[], chromaSettings?: { enabled: boolean; similarity: number; smoothing: number }) =>
    ipcRenderer.invoke('player:open', paths, chromaSettings),
  playerOpenVideoStream: (
    videoPath: string,
    chromaSettings?: { enabled: boolean; similarity: number; smoothing: number }
  ) => ipcRenderer.invoke('player:open-video-stream', videoPath, chromaSettings),
  playerClose: () => ipcRenderer.invoke('player:close'),
  playerPrepareLiveStart: () => ipcRenderer.invoke('player:prepare-live-start'),
  playerAbortLiveStart: () => ipcRenderer.invoke('player:abort-live-start'),
  playerSendPlaylist: (paths: string[]) => ipcRenderer.invoke('player:send-playlist', paths),
  playerStop: () => ipcRenderer.invoke('player:stop'),
  playerSetVolume: (volume: number) => ipcRenderer.invoke('player:set-volume', volume),
  playerIsOpen: () => ipcRenderer.invoke('player:is-open'),
  playerSetChroma: (settings: { enabled: boolean; similarity: number; smoothing: number }) =>
    ipcRenderer.invoke('player:set-chroma', settings),
  playerOpenCamera: (
    deviceId: string,
    profileId: string,
    chromaSettings?: { enabled: boolean; similarity: number; smoothing: number }
  ) => ipcRenderer.invoke('player:open-camera', deviceId, profileId, chromaSettings),
  onPlayerPreviewStatus: (callback: (status: any) => void) => {
    const handler = (_event: any, status: any) => callback(status)
    ipcRenderer.on('player:preview-status', handler)
    return () => ipcRenderer.removeListener('player:preview-status', handler)
  },

  // ── Pipeline (lip-sync) ───────────────────────────────────────────────────
  pipelineSetBackend: (backend: string) => ipcRenderer.invoke('pipeline:set-backend', backend),
  pipelineCheckBackend: (backend: string) => ipcRenderer.invoke('pipeline:check-backend', backend),
  pipelineListBackends: () => ipcRenderer.invoke('pipeline:list-backends'),
  pipelineSetAvatar: (videoPath: string) => ipcRenderer.invoke('pipeline:set-avatar', videoPath),
  pipelineSubmitAudio: (audioPath: string, source: string, text?: string) =>
    ipcRenderer.invoke('pipeline:submit-audio', audioPath, source, text),
  pipelineSubmitTts: (text: string, voice: string, speed: number) =>
    ipcRenderer.invoke('pipeline:submit-tts', text, voice, speed),
  pipelineSubmitMic: (audioBuffer: ArrayBuffer) =>
    ipcRenderer.invoke('pipeline:submit-mic', audioBuffer),
  pipelineCancel: (taskId?: string) => ipcRenderer.invoke('pipeline:cancel', taskId),
  pipelineStatus: () => ipcRenderer.invoke('pipeline:status'),
  onPipelineUpdate: (callback: (task: any) => void) => {
    const handler = (_event: any, task: any) => callback(task)
    ipcRenderer.on('pipeline:task-update', handler)
    return () => ipcRenderer.removeListener('pipeline:task-update', handler)
  },
  onPipelineCompleted: (callback: (task: any) => void) => {
    const handler = (_event: any, task: any) => callback(task)
    ipcRenderer.on('pipeline:task-completed', handler)
    return () => ipcRenderer.removeListener('pipeline:task-completed', handler)
  },
  onPipelineFailed: (callback: (task: any) => void) => {
    const handler = (_event: any, task: any) => callback(task)
    ipcRenderer.on('pipeline:task-failed', handler)
    return () => ipcRenderer.removeListener('pipeline:task-failed', handler)
  },
  onPipelineIdle: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('pipeline:idle', handler)
    return () => ipcRenderer.removeListener('pipeline:idle', handler)
  },
  onPipelineBusy: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('pipeline:busy', handler)
    return () => ipcRenderer.removeListener('pipeline:busy', handler)
  },
  onPlaybackFinished: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('pipeline:playback-finished', handler)
    return () => ipcRenderer.removeListener('pipeline:playback-finished', handler)
  },
  onChunkReady: (callback: (task: any, chunkIndex: number, totalChunks: number) => void) => {
    const handler = (_event: any, task: any, chunkIndex: number, totalChunks: number) =>
      callback(task, chunkIndex, totalChunks)
    ipcRenderer.on('pipeline:chunk-ready', handler)
    return () => ipcRenderer.removeListener('pipeline:chunk-ready', handler)
  },

  // ── Danmaku ───────────────────────────────────────────────────────────────
  danmakuConnect: (roomId: number) => ipcRenderer.invoke('danmaku:connect', roomId),
  danmakuDisconnect: () => ipcRenderer.invoke('danmaku:disconnect'),
  danmakuStatus: () => ipcRenderer.invoke('danmaku:status'),
  danmakuSetAutoReply: (enabled: boolean) => ipcRenderer.invoke('danmaku:set-auto-reply', enabled),
  danmakuSetCooldown: (ms: number) => ipcRenderer.invoke('danmaku:set-cooldown', ms),
  danmakuSetForbiddenWords: (words: string[]) =>
    ipcRenderer.invoke('danmaku:set-forbidden-words', words),
  danmakuSetBlacklist: (userIds: string[]) =>
    ipcRenderer.invoke('danmaku:set-blacklist', userIds),
  onDanmakuMessage: (callback: (msg: any) => void) => {
    const handler = (_event: any, msg: any) => callback(msg)
    ipcRenderer.on('danmaku:message', handler)
    return () => ipcRenderer.removeListener('danmaku:message', handler)
  },
  onDanmakuConnected: (callback: (roomId: number) => void) => {
    const handler = (_event: any, roomId: number) => callback(roomId)
    ipcRenderer.on('danmaku:connected', handler)
    return () => ipcRenderer.removeListener('danmaku:connected', handler)
  },
  onDanmakuDisconnected: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('danmaku:disconnected', handler)
    return () => ipcRenderer.removeListener('danmaku:disconnected', handler)
  },
  onDanmakuPopularity: (callback: (count: number) => void) => {
    const handler = (_event: any, count: number) => callback(count)
    ipcRenderer.on('danmaku:popularity', handler)
    return () => ipcRenderer.removeListener('danmaku:popularity', handler)
  },
  onDanmakuReply: (callback: (data: any) => void) => {
    const handler = (_event: any, data: any) => callback(data)
    ipcRenderer.on('danmaku:reply', handler)
    return () => ipcRenderer.removeListener('danmaku:reply', handler)
  },
  onDanmakuError: (callback: (error: string) => void) => {
    const handler = (_event: any, error: string) => callback(error)
    ipcRenderer.on('danmaku:error', handler)
    return () => ipcRenderer.removeListener('danmaku:error', handler)
  },

  // ── Platform events ─────────────────────────────────────────────────────
  onPlatformEvent: (callback: (event: any) => void) => {
    const handler = (_event: any, ev: any) => callback(ev)
    ipcRenderer.on('platform:event', handler)
    return () => ipcRenderer.removeListener('platform:event', handler)
  },
  onPlatformDisconnected: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('platform:disconnected', handler)
    return () => ipcRenderer.removeListener('platform:disconnected', handler)
  },

  // ── Virtual camera ────────────────────────────────────────────────────────
  cameraStart: () => ipcRenderer.invoke('camera:start'),
  cameraStop: () => ipcRenderer.invoke('camera:stop'),
  cameraStatus: () => ipcRenderer.invoke('camera:status'),

  // ── Room CRUD ─────────────────────────────────────────────────────────────
  roomList: () => ipcRenderer.invoke('room:list'),
  roomGet: (id: string) => ipcRenderer.invoke('room:get', id),
  roomCreate: (data: any) => ipcRenderer.invoke('room:create', data),
  roomUpdate: (id: string, data: any) => ipcRenderer.invoke('room:update', id, data),
  roomDelete: (id: string) => ipcRenderer.invoke('room:delete', id),
  roomSetStatus: (id: string, status: string) => ipcRenderer.invoke('room:set-status', id, status),
  roomCopy: (id: string, newName: string) => ipcRenderer.invoke('room:copy', id, newName),

  // ── Asset management ──────────────────────────────────────────────────────
  assetList: () => ipcRenderer.invoke('asset:list'),
  assetGet: (id: string) => ipcRenderer.invoke('asset:get', id),
  assetImport: (data: any) => ipcRenderer.invoke('asset:import', data),
  assetRename: (id: string, name: string) => ipcRenderer.invoke('asset:rename', id, name),
  assetDelete: (id: string) => ipcRenderer.invoke('asset:delete', id),
  assetSetThumbnail: (id: string, path: string) =>
    ipcRenderer.invoke('asset:set-thumbnail', id, path),
  assetSetFaceDetected: (id: string, value: 0 | 1) =>
    ipcRenderer.invoke('asset:set-face-detected', id, value),

  // ── Profile management ────────────────────────────────────────────────────
  profileList: () => ipcRenderer.invoke('profile:list'),
  profileGet: (id: string) => ipcRenderer.invoke('profile:get', id),
  profileCreate: (data: any) => ipcRenderer.invoke('profile:create', data),
  profileUpdate: (id: string, data: any) => ipcRenderer.invoke('profile:update', id, data),
  profileDelete: (id: string) => ipcRenderer.invoke('profile:delete', id),
  profileSetDefault: (id: string) => ipcRenderer.invoke('profile:set-default', id),
  profileGetDefault: () => ipcRenderer.invoke('profile:get-default'),

  // ── Script management ─────────────────────────────────────────────────────
  scriptGetGeneral: (roomId: string) => ipcRenderer.invoke('script:get-general', roomId),
  scriptSaveGeneral: (roomId: string, content: string) =>
    ipcRenderer.invoke('script:save-general', roomId, content),
  scriptListLinks: (roomId: string) => ipcRenderer.invoke('script:list-links', roomId),
  scriptSaveLink: (roomId: string, slotNo: number, name: string, content: string) =>
    ipcRenderer.invoke('script:save-link', roomId, slotNo, name, content),
  scriptDeleteLink: (roomId: string, slotNo: number) =>
    ipcRenderer.invoke('script:delete-link', roomId, slotNo),
  scriptListShortcuts: (roomId: string) => ipcRenderer.invoke('script:list-shortcuts', roomId),
  scriptSaveShortcut: (roomId: string, data: any) =>
    ipcRenderer.invoke('script:save-shortcut', roomId, data),
  scriptDeleteShortcut: (id: string) => ipcRenderer.invoke('script:delete-shortcut', id),
  scriptGetSettings: (roomId: string) => ipcRenderer.invoke('script:get-settings', roomId),
  scriptSaveSettings: (roomId: string, data: any) =>
    ipcRenderer.invoke('script:save-settings', roomId, data),
  scriptListForbidden: (roomId: string) => ipcRenderer.invoke('script:list-forbidden', roomId),
  scriptAddForbidden: (roomId: string, word: string) =>
    ipcRenderer.invoke('script:add-forbidden', roomId, word),
  scriptDeleteForbidden: (id: string) => ipcRenderer.invoke('script:delete-forbidden', id),
  scriptListBlacklist: (roomId: string) => ipcRenderer.invoke('script:list-blacklist', roomId),
  scriptAddBlacklist: (roomId: string, data: any) =>
    ipcRenderer.invoke('script:add-blacklist', roomId, data),
  scriptDeleteBlacklist: (id: string) => ipcRenderer.invoke('script:delete-blacklist', id),

  // ── Live room control ─────────────────────────────────────────────────────
  liveRoomStart: (roomId: string, options?: any) => ipcRenderer.invoke('live:room-start', roomId, options),
  liveRoomStop: (roomId: string) => ipcRenderer.invoke('live:room-stop', roomId),
  liveRoomPause: (roomId: string) => ipcRenderer.invoke('live:room-pause', roomId),
  liveRoomResume: (roomId: string) => ipcRenderer.invoke('live:room-resume', roomId),
  liveQueueGet: (roomId: string) => ipcRenderer.invoke('live:queue-get', roomId),
  liveQueueSkip: (roomId: string) => ipcRenderer.invoke('live:queue-skip', roomId),
  liveQueueClear: (roomId: string) => ipcRenderer.invoke('live:queue-clear', roomId),
  liveQueueManual: (roomId: string, text: string) =>
    ipcRenderer.invoke('live:queue-manual', roomId, text),
  liveSwitchLink: (roomId: string, linkId: string | null) =>
    ipcRenderer.invoke('live:switch-link', roomId, linkId),
  liveShortcutTrigger: (roomId: string, scriptId: string) =>
    ipcRenderer.invoke('live:shortcut-trigger', roomId, scriptId),
  liveDanmakuPush: (roomId: string, event: any) =>
    ipcRenderer.invoke('live:danmaku-push', roomId, event),
  liveBlacklistAdd: (roomId: string, userId: string, note?: string) =>
    ipcRenderer.invoke('live:blacklist-add', roomId, userId, note),

  // ── Auto-rotation ──────────────────────────────────────────────────────────
  liveRotationEnable: (roomId: string, batchesPerProduct?: number) =>
    ipcRenderer.invoke('live:rotation-enable', roomId, batchesPerProduct),
  liveRotationDisable: (roomId: string) =>
    ipcRenderer.invoke('live:rotation-disable', roomId),
  liveRotationStatus: (roomId: string) =>
    ipcRenderer.invoke('live:rotation-status', roomId),
  onRotationUpdate: (callback: (update: any) => void) => {
    const handler = (_event: any, update: any) => callback(update)
    ipcRenderer.on('live:rotation-update', handler)
    return () => ipcRenderer.removeListener('live:rotation-update', handler)
  },

  // ── Queue push notifications ──────────────────────────────────────────────
  onQueueUpdate: (callback: (queue: any[]) => void) => {
    const handler = (_event: any, queue: any[]) => callback(queue)
    ipcRenderer.on('live:queue-update', handler)
    return () => ipcRenderer.removeListener('live:queue-update', handler)
  },

  // ── Room temperature updates ────────────────────────────────────────────
  onTemperatureUpdate: (callback: (snapshot: any) => void) => {
    const handler = (_event: any, snapshot: any) => callback(snapshot)
    ipcRenderer.on('live:temperature-update', handler)
    return () => ipcRenderer.removeListener('live:temperature-update', handler)
  },

  // ── Camera recording ─────────────────────────────────────────────────────
  cameraRecordSave: (profileId: string, webmBuffer: ArrayBuffer) =>
    ipcRenderer.invoke('camera:record-save', profileId, webmBuffer),

  // ── License / auth ────────────────────────────────────────────────────────
  licenseGetInfo: () => ipcRenderer.invoke('license:get-info'),
  licenseLogin: (account: string, password: string) =>
    ipcRenderer.invoke('license:login', account, password),
  licenseRefresh: () => ipcRenderer.invoke('license:refresh'),
  licenseCanStartLive: () => ipcRenderer.invoke('license:can-start-live'),
  licenseActivate: (token: string) => ipcRenderer.invoke('license:activate', token),
  licenseDeactivate: () => ipcRenderer.invoke('license:deactivate'),
  licenseLogout: () => ipcRenderer.invoke('license:logout'),
  licenseSessionStartTime: () => ipcRenderer.invoke('license:session-start-time'),
  onLicenseShouldStop: (callback: (data: { reason: string }) => void) => {
    const handler = (_event: any, data: any) => callback(data)
    ipcRenderer.on('license:should-stop', handler)
    return () => ipcRenderer.removeListener('license:should-stop', handler)
  },
  onLicenseStatusUpdate: (callback: (info: any) => void) => {
    const handler = (_event: any, info: any) => callback(info)
    ipcRenderer.on('license:status-update', handler)
    return () => ipcRenderer.removeListener('license:status-update', handler)
  },

  // ── Platform adapter ──────────────────────────────────────────────────────
  platformList: () => ipcRenderer.invoke('platform:list'),
  platformStatus: () => ipcRenderer.invoke('platform:status'),
  platformConnect: (platform: string, credential: any) =>
    ipcRenderer.invoke('platform:connect', platform, credential),
  platformDisconnect: () => ipcRenderer.invoke('platform:disconnect')
}

export type ApiType = typeof api

contextBridge.exposeInMainWorld('api', api)
