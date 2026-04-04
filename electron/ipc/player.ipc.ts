import { ipcMain, BrowserWindow, screen, WebContents } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { v4 as uuidv4 } from 'uuid'
import { virtualCameraService } from '../services/virtual-camera.service'
import { pipelineService } from '../services/pipeline.service'
import {
  getActiveBackend,
  getActiveBackendType,
  isNativeRendererBackendType,
  setActiveBackend,
} from '../services/lipsync-backend'
import { YundingyunboService, yundingyunboService } from '../services/yundingyunbo.service'
import { yundingyunboVideoStreamService } from '../services/yundingyunbo-video-stream.service'
import { dbGet } from '../db/index'
import { prepareYdbCameraReferenceVideo } from '../utils/yundingyunbo-avatar'

/** Returns true when yundingyunbo backend is active (V2Manager renders its own window). */
function isNativeYdbActive(): boolean {
  return isNativeRendererBackendType(getActiveBackendType())
}

function getActiveNativeYdbService(): YundingyunboService | null {
  if (!isNativeYdbActive()) return null
  return getActiveBackend() as YundingyunboService
}

function activateNativeBackend(type: 'yundingyunbo' | 'yundingyunbo_video_stream'): void {
  const currentType = getActiveBackendType()
  if (currentType && currentType !== type && isNativeRendererBackendType(currentType)) {
    try {
      ;(getActiveBackend() as YundingyunboService).shutdown('backend-switch', { force: true })
    } catch {
      // ignore stale backend switch failures
    }
  }
  setActiveBackend(type)
}

let playerWindow: BrowserWindow | null = null
let pendingPlaylist: string[] | null = null
let pendingChroma: { enabled: boolean; similarity: number; smoothing: number } | null = null
let pendingCameraConfig: { deviceId: string; profileId: string } | null = null
let cameraCaptureResolve: ((filePath: string) => void) | null = null
let streamAudioPlaying = false
let streamAudioStateUpdatedAt = 0
let streamQueueDepth = 0
let streamQueueMode = 'idle'
let streamQueueStateUpdatedAt = 0
let activeNativePreviewToken: string | null = null

type NativePreviewMode = 'video' | 'camera' | 'video_stream'
type NativePreviewState = 'starting' | 'ready' | 'error'

interface NativePreviewStatusPayload {
  token: string
  state: NativePreviewState
  mode: NativePreviewMode
  avatarPath?: string
  message?: string
}

function isExpectedNativePreviewCancel(message: string): boolean {
  return /Bridge shutdown: (stream-reset|player-close)/i.test(String(message || ''))
}

function formatElapsedSuffix(elapsedSeconds?: number): string {
  const elapsed = Math.max(0, Math.floor(Number(elapsedSeconds || 0)))
  if (elapsed <= 0) return ''
  if (elapsed < 60) return `（已耗时 ${elapsed} 秒）`
  const minutes = Math.floor(elapsed / 60)
  const seconds = elapsed % 60
  return seconds > 0
    ? `（已耗时 ${minutes} 分 ${seconds} 秒）`
    : `（已耗时 ${minutes} 分钟）`
}

function formatNativePreviewStageLabel(stage: string): string {
  const normalized = String(stage || '').trim()
  if (!normalized) return '正在预热预览'

  const labels: Record<string, string> = {
    prepare_reference: '正在截取参考片段',
    reference_prepared: '参考片段已就绪，正在启动引擎',
    starting_bridge: '正在启动云播引擎',
    bridge_ready: '引擎已启动，正在分析视频',
    resolve_data: '正在解析视频数据',
    cache_hit: '检测到可复用角色缓存，正在快速启动',
    preprocess_start: '正在分析视频并建立角色数据',
    clone_video_local_v2: '正在分析人脸并建立角色数据',
    'bin.image_clone.infer_api.process_face_frames': '正在抽帧并处理关键帧',
    creating_manager: '角色数据已完成，正在启动预览窗口',
  }

  return labels[normalized] || `正在预热预览：${normalized}`
}

function formatNativePreviewProgressMessage(
  mode: NativePreviewMode,
  status: {
    stage?: string
    elapsedSeconds?: number
  }
): string {
  const stage = String(status.stage || '').trim()
  const elapsedSuffix = formatElapsedSuffix(status.elapsedSeconds)

  if (stage === 'prepare_reference') {
    return mode === 'camera'
      ? `正在准备摄像头参考片段${elapsedSuffix}`
      : `正在截取参考片段${elapsedSuffix}`
  }

  if (stage === 'reference_prepared') {
    return mode === 'camera'
      ? `摄像头参考片段已就绪，正在启动引擎${elapsedSuffix}`
      : `参考片段已就绪，正在启动引擎${elapsedSuffix}`
  }

  return `${formatNativePreviewStageLabel(stage)}${elapsedSuffix}`
}

function createNativePreviewToken(): string {
  const token = uuidv4()
  activeNativePreviewToken = token
  return token
}

function clearNativePreviewToken(expectedToken?: string): void {
  if (expectedToken && activeNativePreviewToken !== expectedToken) return
  activeNativePreviewToken = null
}

function isNativePreviewTokenActive(token: string): boolean {
  return activeNativePreviewToken === token
}

function sendNativePreviewStatus(
  target: WebContents,
  payload: NativePreviewStatusPayload
): void {
  if (!target.isDestroyed()) {
    target.send('player:preview-status', payload)
  }
}

function startNativePreviewInit(
  target: WebContents,
  token: string,
  mode: NativePreviewMode,
  service: YundingyunboService,
  avatarPath: string,
  startingMessage: string
): void {
  console.log(`[Player] Preview start: mode=${mode}, avatar=${avatarPath}, token=${token}`)
  sendNativePreviewStatus(target, {
    token,
    state: 'starting',
    mode,
    avatarPath,
    message: startingMessage
  })

  void (async () => {
    let lastStatusMessage = startingMessage
    const globalStartMs = Date.now()
    const forwardInitStatus = (status: {
      stage?: string
      elapsedSeconds?: number
    }) => {
      if (!isNativePreviewTokenActive(token)) return
      const globalElapsed = Math.floor((Date.now() - globalStartMs) / 1000)
      const message = formatNativePreviewProgressMessage(mode, {
        ...status,
        elapsedSeconds: globalElapsed
      })
      if (!message || message === lastStatusMessage) return
      lastStatusMessage = message
      sendNativePreviewStatus(target, {
        token,
        state: 'starting',
        mode,
        avatarPath,
        message
      })
    }

    service.on('init-avatar-status', forwardInitStatus)
    try {
      await service.initAvatar(avatarPath)
      if (!isNativePreviewTokenActive(token)) {
        console.log(`[Player] Ignored stale native preview ready: token=${token}`)
        return
      }
      const avatarInfo = service.getAvatarInfo?.() || null
      const videoFps = avatarInfo?.fps && avatarInfo.fps > 0 ? avatarInfo.fps : 0
      const videoFrames = avatarInfo?.nFrames && avatarInfo.nFrames > 0 ? avatarInfo.nFrames : 0
      const videoDurationSec = videoFps > 0 && videoFrames > 0 ? videoFrames / videoFps : 0
      sendNativePreviewStatus(target, {
        token,
        state: 'ready',
        mode,
        avatarPath,
        videoFps,
        videoFrames,
        videoDurationSec
      })
    } catch (err: any) {
      const message = err?.message || String(err)
      if (!isNativePreviewTokenActive(token)) {
        console.warn(`[Player] Ignored stale native preview error: ${message}`)
        return
      }
      if (isExpectedNativePreviewCancel(message)) {
        clearNativePreviewToken(token)
        console.log(`[Player] Native preview init cancelled: ${message}`)
        return
      }
      clearNativePreviewToken(token)
      console.error(`[Player] Native preview init failed: ${message}`)
      try {
        service.shutdown('preview-init-failed', { force: true })
      } catch {
        // ignore double-shutdown races
      }
      sendNativePreviewStatus(target, {
        token,
        state: 'error',
        mode,
        avatarPath,
        message
      })
    } finally {
      service.off('init-avatar-status', forwardInitStatus)
    }
  })()
}

function getPlayerWindow(): BrowserWindow | null {
  if (playerWindow && !playerWindow.isDestroyed()) {
    return playerWindow
  }
  return null
}

function createPlayerWindow(parentWindow: BrowserWindow | null): BrowserWindow {
  // Position player window on the right side of the screen
  const display = screen.getPrimaryDisplay()
  const { width: screenW, height: screenH } = display.workAreaSize

  // Default player size: 480x720 (portrait for digital human)
  const winW = 480
  const winH = 720
  const x = screenW - winW - 20
  const y = Math.round((screenH - winH) / 2)

  playerWindow = new BrowserWindow({
    width: winW,
    height: winH,
    x,
    y,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: false,
    show: false,
    parent: parentWindow || undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/player.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // Allow loading local video files
      webSecurity: false
    }
  })

  // 生产环境：拦截 DevTools 快捷键 & 禁用右键菜单
  if (!is.dev) {
    playerWindow.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'F12') event.preventDefault()
      if (input.control && input.shift && ['I', 'J', 'C'].includes(input.key)) {
        event.preventDefault()
      }
    })
  }

  playerWindow.on('ready-to-show', () => {
    playerWindow?.show()
  })

  // Forward player console messages to main process terminal
  playerWindow.webContents.on('console-message', (_event, level, message) => {
    const tag = level <= 1 ? 'LOG' : level === 2 ? 'WARN' : 'ERROR'
    console.log(`[Player ${tag}]: ${message}`)
  })

  playerWindow.on('closed', () => {
    playerWindow = null
    pendingPlaylist = null
    streamAudioPlaying = false
    streamAudioStateUpdatedAt = Date.now()
    streamQueueDepth = 0
    streamQueueMode = 'idle'
    streamQueueStateUpdatedAt = Date.now()
  })

  // Load player page
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    playerWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/player.html`)
  } else {
    playerWindow.loadFile(join(__dirname, '../renderer/player.html'))
  }

  return playerWindow
}

export function registerPlayerIpc(): void {
  // Open player window with a playlist (and optional chroma settings)
  ipcMain.handle('player:open', async (event, paths: string[], chromaSettings?: { enabled: boolean; similarity: number; smoothing: number }) => {
    activateNativeBackend('yundingyunbo')
    if (isNativeYdbActive()) {
      // Video mode: ensure camera mode is off
      yundingyunboService.setSessionOwner('preview')
      yundingyunboService.setCameraModeEnabled(false)
      const avatarPath = paths.find((item) => typeof item === 'string' && item.trim().length > 0)
      if (avatarPath) {
        const token = createNativePreviewToken()
        const previewMessage = '正在预热预览，首次会截取参考片段并预热模型。参考片段最长 3 分钟，但完整视频仍会完整播放；大型视频首次通常需要几十秒到数分钟，请勿重复点击。'
        startNativePreviewInit(
          event.sender,
          token,
          'video',
          yundingyunboService,
          avatarPath,
          previewMessage
        )
        console.log('[Player] Native yundingyunbo preview init started in background')
        return {
          success: true,
          nativeRenderer: true,
          pendingInit: true,
          previewToken: token,
          previewMessage
        }
      }
      clearNativePreviewToken()
      console.log('[Player] Skipped: yundingyunbo backend renders its own window')
      return { success: true, nativeRenderer: true }
    }
    const mainWin = BrowserWindow.fromWebContents(event.sender)
    const chroma = chromaSettings || { enabled: false, similarity: 80, smoothing: 1 }
    const existing = getPlayerWindow()
    if (existing) {
      // Already open, send new playlist and chroma
      existing.webContents.send('player:playlist', paths)
      existing.webContents.send('player:set-chroma', chroma)
      existing.focus()
      return { success: true }
    }

    // Store playlist and chroma to send once player is ready
    pendingPlaylist = paths
    pendingChroma = chroma
    createPlayerWindow(mainWin)
    return { success: true }
  })

  // Open player window in camera mode — captures 3s video, returns MP4 path
  ipcMain.handle(
    'player:open-video-stream',
    async (
      event,
      avatarPath: string,
      _chromaSettings?: { enabled: boolean; similarity: number; smoothing: number }
    ) => {
      activateNativeBackend('yundingyunbo_video_stream')
      const normalizedAvatarPath = String(avatarPath || '').trim()
      if (!normalizedAvatarPath) {
        return { success: false, error: 'video_stream preview requires a video path' }
      }

      yundingyunboVideoStreamService.setSessionOwner('preview')
      yundingyunboVideoStreamService.setCameraModeEnabled(false)
      const token = createNativePreviewToken()
      const previewMessage =
        '姝ｅ湪鍚姩瑙嗛娴佸紡棰勮锛氬弬鑰冧粎鐢ㄤ簬妯″瀷棰勭儹锛屽彲瑙佺敾闈㈠皢浠庡畬鏁撮暱瑙嗛 0 绉掑紑濮嬮『搴忔挱鏀俱€?'
      startNativePreviewInit(
        event.sender,
        token,
        'video_stream',
        yundingyunboVideoStreamService,
        normalizedAvatarPath,
        previewMessage
      )
      console.log('[Player] Native yundingyunbo video-stream preview init started in background')
      return {
        success: true,
        nativeRenderer: true,
        pendingInit: true,
        previewToken: token,
        previewMessage
      }
    }
  )

  ipcMain.handle('player:open-camera', async (
    event,
    deviceId: string,
    profileId: string,
    chromaSettings?: { enabled: boolean; similarity: number; smoothing: number }
  ) => {
    activateNativeBackend('yundingyunbo')
    if (isNativeYdbActive()) {
      // yundingyunbo camera mode: V2Manager handles webcam natively.
      // We need a proper avatar video for face reference (clone_video_local).
      // Look up the profile's avatar video — prefer the real imported video,
      // NOT camera recordings (which are low-res 640x480 short clips).
      yundingyunboService.setSessionOwner('preview')
      const profile = dbGet(
        `SELECT p.*, av.file_path as video_path
         FROM dh_profiles p
         LEFT JOIN avatar_videos av ON av.id = p.video_id
         WHERE p.id = ?`,
        [profileId]
      )
      const videoPath = await prepareYdbCameraReferenceVideo(
        profile?.video_path as string | undefined
      )

      if (!videoPath) {
        console.warn('[Player] yundingyunbo camera mode requires an avatar video for face reference')
        return { success: false, error: 'yundingyunbo 摄像头模式需要至少导入一个形象视频作为人脸参考' }
      }

      const cameraDeviceLabel = (profile?.camera_device_label as string | undefined) || ''
      const camIdx = await yundingyunboService.resolveCameraIndex(deviceId, cameraDeviceLabel)
      yundingyunboService.setCameraModeEnabled(true, camIdx)
      const token = createNativePreviewToken()
      const previewMessage = '正在启动摄像头预览并预热模型，首次约需几十秒'
      startNativePreviewInit(
        event.sender,
        token,
        'camera',
        yundingyunboService,
        videoPath,
        previewMessage
      )

      console.log(
        `[Player] yundingyunbo camera mode: camIdx=${camIdx}, label=${cameraDeviceLabel || 'n/a'}, faceRef=${videoPath}`
      )
      return {
        success: true,
        capturedVideoPath: videoPath,
        nativeRenderer: true,
        pendingInit: true,
        previewToken: token,
        previewMessage
      }
    }
    const mainWin = BrowserWindow.fromWebContents(event.sender)
    const chroma = chromaSettings || { enabled: false, similarity: 80, smoothing: 1 }
    const existing = getPlayerWindow()
    if (existing) {
      existing.webContents.send('player:enable-camera', deviceId, profileId)
      existing.webContents.send('player:set-chroma', chroma)
      existing.focus()
    } else {
      pendingCameraConfig = { deviceId, profileId }
      pendingPlaylist = null
      pendingChroma = chroma
      createPlayerWindow(mainWin)
    }

    try {
      const capturedVideoPath = await waitForCameraCapture()
      return { success: true, capturedVideoPath }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // Player signals it's ready - send pending playlist, chroma settings, and camera config
  ipcMain.on('player:ready', () => {
    const win = getPlayerWindow()
    if (win && pendingPlaylist) {
      win.webContents.send('player:playlist', pendingPlaylist)
      pendingPlaylist = null
    }
    // Always send chroma settings — default to disabled if none were provided
    if (win) {
      const chroma = pendingChroma || { enabled: false, similarity: 80, smoothing: 1 }
      console.log('[Chroma] Sending chroma to player on ready:', JSON.stringify(chroma))
      win.webContents.send('player:set-chroma', chroma)
      pendingChroma = null
    }
    // Camera mode: send enable-camera after playlist/chroma
    if (win && pendingCameraConfig) {
      win.webContents.send('player:enable-camera', pendingCameraConfig.deviceId, pendingCameraConfig.profileId)
      console.log('[Player] Sent enable-camera to player:', pendingCameraConfig.deviceId)
      pendingCameraConfig = null
    }
  })

  // Audio state from player renderer (frame-stream insertion decision helper).
  ipcMain.on('player:stream-audio-state', (_event, playing: boolean, ts?: number) => {
    streamAudioPlaying = !!playing
    streamAudioStateUpdatedAt =
      typeof ts === 'number' && Number.isFinite(ts) ? Math.floor(ts) : Date.now()
  })

  ipcMain.on(
    'player:stream-queue-state',
    (_event, depth: number, mode?: string, ts?: number) => {
      const normalizedDepth = Number.isFinite(depth) ? Math.max(0, Math.floor(depth)) : 0
      streamQueueDepth = normalizedDepth
      streamQueueMode =
        typeof mode === 'string' && mode.trim().length > 0 ? mode.trim() : 'idle'
      streamQueueStateUpdatedAt =
        typeof ts === 'number' && Number.isFinite(ts) ? Math.floor(ts) : Date.now()
    }
  )

  // Camera capture ready signal from player window
  ipcMain.on('player:camera-capture-ready', (_event, filePath: string) => {
    console.log('[Player] Camera capture ready:', filePath)
    if (cameraCaptureResolve) {
      cameraCaptureResolve(filePath)
      cameraCaptureResolve = null
    }
    // Notify pipeline to re-init avatar with new camera reference at next sentence boundary
    pipelineService.refreshCameraAvatar(filePath)
  })

  // Live camera frame injection — relay JPEG base64 from player renderer to F2F engine
  let injectFrameCount = 0
  ipcMain.on('player:inject-camera-frame', (_event, jpegBase64: string) => {
    if (typeof jpegBase64 === 'string' && jpegBase64.length > 0) {
      injectFrameCount++
      if (injectFrameCount <= 3 || injectFrameCount % 50 === 0) {
        console.log(`[Player IPC] inject-camera-frame #${injectFrameCount}: ${(jpegBase64.length / 1024).toFixed(0)} KB base64`)
      }
      pipelineService.injectCameraFrame(jpegBase64)
    }
  })

  // Clear camera frame injection when camera mode ends
  ipcMain.on('player:clear-camera-frame', () => {
    pipelineService.clearCameraFrame()
  })

  // Close player window
  ipcMain.handle('player:close', () => {
    const activeService = getActiveNativeYdbService()
    if (activeService) {
      clearNativePreviewToken()
      const owner = activeService.getSessionOwner?.() || 'unknown'
      console.log(`[Player] player:close received, sessionOwner=${owner}, forwarding shutdown('player-close')`)
      activeService.shutdown('player-close')
      return { success: true, nativeRenderer: true }
    }
    const win = getPlayerWindow()
    if (win) {
      win.close()
    }
    return { success: true }
  })

  ipcMain.handle('player:prepare-live-start', () => {
    const activeService = getActiveNativeYdbService()
    if (activeService) {
      activeService.prepareLiveTransition()
      return { success: true, nativeRenderer: true }
    }
    return { success: true, nativeRenderer: false }
  })

  ipcMain.handle('player:abort-live-start', () => {
    const activeService = getActiveNativeYdbService()
    if (activeService) {
      activeService.cancelPreparedLiveTransition()
      return { success: true, nativeRenderer: true }
    }
    return { success: true, nativeRenderer: false }
  })

  // Toggle always-on-top
  ipcMain.handle('player:toggle-ontop', () => {
    const win = getPlayerWindow()
    if (win) {
      const current = win.isAlwaysOnTop()
      win.setAlwaysOnTop(!current)
      return { alwaysOnTop: !current }
    }
    return { alwaysOnTop: false }
  })

  // Send playlist to player
  ipcMain.handle('player:send-playlist', (_event, paths: string[]) => {
    const win = getPlayerWindow()
    if (win) {
      win.webContents.send('player:playlist', paths)
      return { success: true }
    }
    return { success: false, error: 'Player not open' }
  })

  // Stop playback
  ipcMain.handle('player:stop', () => {
    const activeService = getActiveNativeYdbService()
    if (activeService) {
      clearNativePreviewToken()
      activeService.shutdown('player-stop')
      console.log('[Player] Stopped native yundingyunbo session')
      return { success: true, nativeRenderer: true }
    }
    const win = getPlayerWindow()
    if (win) {
      win.webContents.send('player:stop')
      return { success: true }
    }
    return { success: false, error: 'Player not open' }
  })

  // Set volume
  ipcMain.handle('player:set-volume', (_event, volume: number) => {
    const win = getPlayerWindow()
    if (win) {
      win.webContents.send('player:set-volume', volume)
      return { success: true }
    }
    return { success: false }
  })

  // Check if player is open
  ipcMain.handle('player:is-open', () => {
    return { open: getPlayerWindow() !== null }
  })

  // Virtual camera controls
  ipcMain.handle('camera:start', () => {
    try {
      virtualCameraService.start('Player')
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('camera:stop', () => {
    virtualCameraService.stop()
    return { success: true }
  })

  ipcMain.handle('camera:status', () => {
    return virtualCameraService.getStatus()
  })

  // Forward chroma key settings to player window
  ipcMain.handle('player:set-chroma', (_event, settings: { enabled: boolean; similarity: number; smoothing: number }) => {
    console.log('[Chroma] IPC received:', JSON.stringify(settings))
    const win = getPlayerWindow()
    if (win) {
      win.webContents.send('player:set-chroma', settings)
      console.log('[Chroma] Forwarded to player window')
      return { success: true }
    }
    console.log('[Chroma] Player window not found!')
    return { success: false, error: 'Player not open' }
  })
}

/**
 * Open the player window with the given video path (or send playlist if already open).
 * Called by live-room.ipc.ts when starting a live session.
 * Optionally accepts chroma settings to apply once the player is ready.
 */
export function openPlayerWithVideo(
  videoPath: string,
  chromaSettings?: { enabled: boolean; similarity: number; smoothing: number }
): void {
  if (isNativeYdbActive()) {
    console.log('[Player] Skipped: yundingyunbo backend renders its own window')
    return
  }
  const chroma = chromaSettings || { enabled: false, similarity: 80, smoothing: 1 }
  const existing = getPlayerWindow()
  if (existing) {
    existing.webContents.send('player:playlist', [videoPath])
    existing.webContents.send('player:set-chroma', chroma)
    existing.focus()
    return
  }
  pendingPlaylist = [videoPath]
  pendingChroma = chroma
  createPlayerWindow(null)
}

/**
 * Query the player window for its current playback position.
 * Returns null if player is not open or doesn't respond within 1s.
 */
export function queryPlayerPosition(): Promise<{ currentTime: number; duration: number } | null> {
  const player = getPlayerWindow()
  if (!player || player.isDestroyed()) return Promise.resolve(null)

  return new Promise((resolve) => {
    const nonce = uuidv4()
    const timeout = setTimeout(() => {
      ipcMain.removeAllListeners(`player:position-response:${nonce}`)
      resolve(null)
    }, 1000)

    ipcMain.once(`player:position-response:${nonce}`, (_event, data) => {
      clearTimeout(timeout)
      resolve(data)
    })

    player.webContents.send('player:query-position', nonce)
  })
}

/**
 * Tell the player to fully stop and reset all playback state.
 */
export function sendPlayerStop(): void {
  const activeService = getActiveNativeYdbService()
  if (activeService) {
    clearNativePreviewToken()
    activeService.shutdown('sendPlayerStop')
    console.log('[Player] sendPlayerStop -> native yundingyunbo shutdown')
    return
  }
  const player = getPlayerWindow()
  if (player && !player.isDestroyed()) {
    player.webContents.send('player:stop')
  }
}

/**
 * Tell the player to seek its idle video to a specific time after streaming ends.
 */
export function sendPlayerSeek(seekTime: number): void {
  const player = getPlayerWindow()
  if (player && !player.isDestroyed()) {
    player.webContents.send('player:set-idle-seek', seekTime)
  }
}

/**
 * Tell the player the idle-video position it should display during the gap between
 * consecutive tasks. Unlike sendPlayerSeek (which exits streaming mode), this is only
 * used temporarily: if the player runs out of chunks before the next task's first chunk
 * arrives, it switches to the moving idle video at this position instead of showing a
 * frozen synthesis frame.
 */
export function sendPlayerGapSeek(seekTime: number): void {
  const player = getPlayerWindow()
  if (player && !player.isDestroyed()) {
    player.webContents.send('player:set-gap-seek', seekTime)
  }
}

export function getPlayerStreamAudioState(): { playing: boolean; updatedAt: number } {
  return {
    playing: streamAudioPlaying,
    updatedAt: streamAudioStateUpdatedAt
  }
}

export function getPlayerStreamQueueState(): {
  depth: number
  mode: string
  updatedAt: number
} {
  return {
    depth: streamQueueDepth,
    mode: streamQueueMode,
    updatedAt: streamQueueStateUpdatedAt
  }
}

/**
 * Open the player window in camera mode — shows live camera feed instead of idle video.
 * The player auto-captures a 3s video for F2F avatar, then signals camera-capture-ready.
 */
export function openPlayerWithCamera(
  deviceId: string,
  profileId: string,
  chromaSettings?: { enabled: boolean; similarity: number; smoothing: number }
): void {
  if (isNativeYdbActive()) {
    console.log('[Player] Skipped camera window: yundingyunbo backend handles camera natively')
    return
  }
  const chroma = chromaSettings || { enabled: false, similarity: 80, smoothing: 1 }
  const existing = getPlayerWindow()
  if (existing) {
    existing.webContents.send('player:enable-camera', deviceId, profileId)
    existing.webContents.send('player:set-chroma', chroma)
    existing.focus()
    return
  }
  pendingCameraConfig = { deviceId, profileId }
  pendingPlaylist = null
  pendingChroma = chroma
  createPlayerWindow(null)
}

/**
 * Wait for the player to finish capturing camera video and converting to MP4.
 * Resolves with the local MP4 file path.
 */
export function waitForCameraCapture(timeoutMs = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cameraCaptureResolve = null
      reject(new Error('Camera capture timeout'))
    }, timeoutMs)

    cameraCaptureResolve = (filePath: string) => {
      clearTimeout(timeout)
      resolve(filePath)
    }
  })
}

/**
 * Tell the player to disable camera mode (stop camera stream).
 */
export function sendDisableCamera(): void {
  const player = getPlayerWindow()
  if (player && !player.isDestroyed()) {
    player.webContents.send('player:disable-camera')
  }
}
