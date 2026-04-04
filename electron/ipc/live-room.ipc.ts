import { ipcMain } from 'electron'
import { v4 as uuidv4 } from 'uuid'
import { dbGet, dbRun, dbAll, saveDatabase } from '../db/index'
import { queueManager } from '../services/queue.manager'
import { aiLoopService } from '../services/ai-loop.service'
import { eventBatcher } from '../services/event-batcher'
import { roomSessionService } from '../services/room-session.service'
import { ttsService } from '../services/tts.service'
import { liveTranslationService } from '../services/live-translation.service'
import { pipelineService } from '../services/pipeline.service'
import { livePipelineService } from '../services/live-pipeline.service'
import { platformManager } from '../services/platform/platform.manager'
import { danmakuReplyService } from '../services/danmaku-reply.service'
import { roomTemperatureService } from '../services/room-temperature'
import { orderedGeneralizeService } from '../services/ordered-generalize.service'
import { openPlayerWithVideo, openPlayerWithCamera, waitForCameraCapture, sendDisableCamera, sendPlayerStop } from './player.ipc'
import {
  getActiveBackend,
  getActiveBackendType,
  isNativeRendererBackendType,
  setActiveBackend,
  type BackendType,
} from '../services/lipsync-backend'
import { YundingyunboService, yundingyunboService } from '../services/yundingyunbo.service'
import { licenseService } from '../services/license.service'
import { prepareYdbCameraReferenceVideo } from '../utils/yundingyunbo-avatar'
import type { DanmakuEvent } from '../services/event-batcher'

function normalizeChineseTranslation(sourceText: string, translatedText: string | null | undefined): string | null {
  const source = String(sourceText || '').trim()
  const translated = String(translatedText || '').trim()

  if (!translated) return null
  if (translated === source) return null
  return /[\u4e00-\u9fff]/.test(translated) ? translated : null
}

async function prepareQueueLine(text: string, targetLang: string): Promise<{ spokenText: string; translatedText: string | null }> {
  const sourceText = text.trim()
  if (!sourceText || targetLang === 'zh-CN') {
    return { spokenText: sourceText || text, translatedText: null }
  }

  const spokenText = await liveTranslationService.translateSingleLine(sourceText, targetLang)
  if (spokenText && spokenText !== sourceText) {
    return { spokenText, translatedText: sourceText }
  }

  const translatedText = await liveTranslationService.translateSingleLine(spokenText || sourceText, 'zh-CN')
  return {
    spokenText: spokenText || sourceText,
    translatedText: normalizeChineseTranslation(spokenText || sourceText, translatedText)
  }
}

function activateNativeBackend(type: BackendType): void {
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

export function registerLiveRoomIpc(): void {
  // ── Room lifecycle ────────────────────────────────────────────────────────

  ipcMain.handle('live:room-start', async (
    _e,
    roomId: string,
    options?: { cameraHints?: Array<{ deviceId?: string; label?: string }> }
  ) => {
    try {
      // Check license before starting
      const licenseCheck = licenseService.canStartLive()
      if (!licenseCheck.allowed) {
        return { ok: false, error: licenseCheck.reason || '授权验证失败' }
      }

      const room = dbGet('SELECT * FROM rooms WHERE id = ?', [roomId])
      if (!room) return { ok: false, error: 'Room not found' }

      // Load profile + join avatar_videos to get the actual file path
      // If room has no profile_id, fall back to the default profile
      let profileId = room.profile_id
      if (!profileId) {
        const defaultProfile = dbGet(
          `SELECT id FROM dh_profiles WHERE is_default = 1 LIMIT 1`
        )
        if (defaultProfile) {
          profileId = defaultProfile.id
          console.log(`[LiveRoom] Room has no profile, using default profile: ${profileId}`)
        }
      }

      const profile = profileId
        ? dbGet(
            `SELECT p.*, av.file_path as video_path
             FROM dh_profiles p
             LEFT JOIN avatar_videos av ON av.id = p.video_id
             WHERE p.id = ?`,
            [profileId]
          )
        : null
      const avatarVideoPath = profile?.video_path as string | undefined
      const mediaType = (profile?.media_type as string | undefined) || 'video'
      const backendType: BackendType =
        mediaType === 'video_stream' ? 'yundingyunbo_video_stream' : 'yundingyunbo'
      activateNativeBackend(backendType)
      const activeBackend = getActiveBackend()
      const activeBackendType = getActiveBackendType()
      const activeNativeService = activeBackend as YundingyunboService
      const ydbCameraReferenceVideo =
        mediaType === 'camera' && backendType === 'yundingyunbo'
          ? await prepareYdbCameraReferenceVideo(avatarVideoPath)
          : (avatarVideoPath || '')
      const chromaSettings = {
        enabled: !!profile?.chroma_enabled,
        similarity: (profile?.chroma_similarity as number) ?? 80,
        smoothing: (profile?.chroma_smoothing as number) ?? 1
      }

      // Cancel any stale pipeline tasks from previous session
      const isNativeYdb = isNativeRendererBackendType(activeBackendType)
      const rendererMode = isNativeYdb ? 'native' : 'electron'

      if (isNativeYdb) {
        // Claim the native renderer immediately so a stale preview teardown
        // cannot close the bridge while live startup is in flight.
        activeNativeService.setSessionOwner('live')
      }

      pipelineService.cancelAll('room-start')

      if (isNativeYdb) {
        // cancelAll() may force-reset a stale preview bridge; reclaim ownership
        // before starting the live session's fresh init flow.
        activeNativeService.setSessionOwner('live')
      }

      if (mediaType === 'camera') {
        // ── Camera mode: open player with live camera, auto-capture for F2F avatar ──
        const cameraDeviceId = profile?.camera_device_id as string
        const cameraHintLabel = options?.cameraHints?.find((item) => item?.deviceId === cameraDeviceId)?.label?.trim()
        const cameraDeviceLabel = (profile?.camera_device_label as string | undefined) || cameraHintLabel
        if (!cameraDeviceId) {
          return { ok: false, error: '未设置摄像头设备。请先在「形象配置」中选择摄像头。' }
        }

        if (cameraHintLabel && !profile?.camera_device_label && profileId) {
          dbRun('UPDATE dh_profiles SET camera_device_label = ? WHERE id = ?', [cameraHintLabel, profileId])
          saveDatabase()
        }

        if (isNativeYdb) {
          if (!ydbCameraReferenceVideo) {
            return { ok: false, error: '摄像头模式需要绑定一个形象视频作为口型参考，请先在方案里选择视频文件。' }
          }

          // yundingyunbo V2Manager handles camera capture + rendering natively
          const camIdx = await yundingyunboService.resolveCameraIndex(cameraDeviceId, cameraDeviceLabel)
          yundingyunboService.setCameraModeEnabled(true, camIdx)
          pipelineService.setAvatarVideo(ydbCameraReferenceVideo)
          await yundingyunboService.initAvatar(ydbCameraReferenceVideo)
          console.log(
            `[LiveRoom] yundingyunbo camera mode: camIdx=${camIdx}, label=${cameraDeviceLabel || 'n/a'}, avatar=${ydbCameraReferenceVideo}`
          )
        } else {
          openPlayerWithCamera(cameraDeviceId, profileId, chromaSettings)

          // Wait for player to capture 3s video and convert to MP4
          console.log('[LiveRoom] Waiting for camera capture...')
          const capturedVideoPath = await waitForCameraCapture()
          console.log('[LiveRoom] Camera capture ready:', capturedVideoPath)

          pipelineService.setAvatarVideo(capturedVideoPath)
        }
      } else {
        // ── Video mode: existing flow ──
        if (!avatarVideoPath) {
          return { ok: false, error: '未配置形象视频。请先在「形象配置」Tab 创建配置并绑定视频，然后应用到此房间。' }
        }

        pipelineService.setAvatarVideo(avatarVideoPath)
        if (!isNativeYdb) {
          openPlayerWithVideo(avatarVideoPath, chromaSettings)
        } else {
          activeNativeService.setCameraModeEnabled(false)
          await activeNativeService.initAvatar(avatarVideoPath)
          console.log(
            `[LiveRoom] ${mediaType === 'video_stream' ? 'yundingyunbo video-stream' : 'yundingyunbo video'} mode: skipping Electron player (native renderer)`
          )
        }
      }

      // Start session (loads general script into memory)
      roomSessionService.start(roomId)
      orderedGeneralizeService.resetRoom(roomId)

      // Load forbidden words and blacklist into event batcher AND danmaku reply service
      const forbidden = dbAll('SELECT word FROM forbidden_words WHERE room_id = ?', [roomId])
      const blacklist = dbAll('SELECT platform_user_id FROM blacklist WHERE room_id = ?', [roomId])
      const forbiddenWords = forbidden.map(r => r.word as string)
      const blacklistIds = blacklist.map(r => r.platform_user_id as string)
      eventBatcher.setForbiddenWords(forbiddenWords)
      eventBatcher.setBlacklist(blacklistIds)
      danmakuReplyService.setForbiddenWords(forbiddenWords)
      danmakuReplyService.setBlacklist(blacklistIds)

      // Connect event batcher → AI loop + danmaku reply filter
      eventBatcher.onBatch((events) => {
        aiLoopService.receiveBatch(events)
      })

      // Immediate comment callback → danmakuReplyService (bypasses 4s batch window)
      // This lets high-value comments trigger generation within ~1s instead of ~5s
      eventBatcher.onImmediate((event) => {
        danmakuReplyService.receiveDanmaku({
          text: event.content,
          username: event.nickname,
          uid: Number(event.userId) || 0,
          timestamp: event.timestamp
        })
      })
      eventBatcher.start()

      // Enable danmaku auto-reply (routes high-value comments to priority queue)
      danmakuReplyService.setAiLoopBridge((item) => aiLoopService.addPriorityReply(item))
      danmakuReplyService.setEnabled(true)

      // Start room temperature tracking
      roomTemperatureService.start()

      // Start queue stale-drop timer
      queueManager.start()

      // Start AI loop
      aiLoopService.start(roomId)

      // Start live pipeline (queue → lip-sync)
      livePipelineService.start(roomId)

      // Update room status
      dbRun('UPDATE rooms SET status = ? WHERE id = ?', ['running', roomId])
      saveDatabase()

      // Start license heartbeat (reports 1h usage to server)
      licenseService.startHeartbeat()

      console.log(`[LiveRoom] Room ${roomId} started (mode=${mediaType || 'video'})`)
      return {
        ok: true,
        avatarVideoPath: ydbCameraReferenceVideo || avatarVideoPath || null,
        mediaType: mediaType || 'video',
        rendererMode,
      }
    } catch (err: any) {
      if (isNativeRendererBackendType(getActiveBackendType())) {
        ;(getActiveBackend() as YundingyunboService).clearSessionOwner('live')
      }
      console.error('[LiveRoom] start error:', err.message)
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle('live:room-stop', async (_e, roomId: string) => {
    try {
      // 0. Stop license heartbeat and report partial usage
      await licenseService.stopHeartbeat()

      // 1. Stop all generators (AI loop, event batching, temperature tracking)
      aiLoopService.stop()
      eventBatcher.stop()
      roomTemperatureService.stop()

      // 2. Stop live pipeline (unsubscribes chunk/audio-ended listeners)
      livePipelineService.stop()

      // 3. Cancel all in-flight pipeline tasks (closes append stream, resets avatar clock)
      pipelineService.cancelAll('room-stop')

      // 4. Fully reset the player (stop audio, clear frame queues, exit streaming mode)
      sendPlayerStop()

      // 5. Reset native camera mode before releasing the live session.
      if (isNativeRendererBackendType(getActiveBackendType())) {
        ;(getActiveBackend() as YundingyunboService).setCameraModeEnabled(false)
      }

      // 6. Disable danmaku auto-reply (but keep platform connected — 视频号扫码成本高)
      danmakuReplyService.setEnabled(false)

      // 7. Clear ALL queue items (buffered + playing + pending)
      queueManager.dropAllBuffered()
      queueManager.clearPending()
      queueManager.stop()

      // 8. Unload room session context
      orderedGeneralizeService.resetRoom(roomId)
      roomSessionService.stop(roomId)
      sendDisableCamera()
      if (isNativeRendererBackendType(getActiveBackendType())) {
        ;(getActiveBackend() as YundingyunboService).clearSessionOwner('live')
      }

      dbRun('UPDATE rooms SET status = ? WHERE id = ?', ['idle', roomId])
      saveDatabase()

      console.log(`[LiveRoom] Room ${roomId} stopped (full reset)`)
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle('live:room-pause', async (_e, roomId: string) => {
    aiLoopService.stop()
    dbRun('UPDATE rooms SET status = ? WHERE id = ?', ['paused', roomId])
    saveDatabase()
    return { ok: true }
  })

  ipcMain.handle('live:room-resume', async (_e, roomId: string) => {
    aiLoopService.start(roomId)
    dbRun('UPDATE rooms SET status = ? WHERE id = ?', ['running', roomId])
    saveDatabase()
    return { ok: true }
  })

  // ── Queue management ──────────────────────────────────────────────────────

  ipcMain.handle('live:queue-get', (_e, _roomId: string) => {
    return queueManager.getQueue()
  })

  ipcMain.handle('live:queue-skip', (_e, _roomId: string) => {
    livePipelineService.skipCurrent()
    return { ok: true }
  })

  ipcMain.handle('live:queue-clear', (_e, _roomId: string) => {
    livePipelineService.clearQueue()
    return { ok: true }
  })

  ipcMain.handle('live:queue-manual', async (_e, roomId: string, text: string) => {
    const profile = dbGet(`
      SELECT p.tts_voice, p.tts_speed
      FROM rooms r
      LEFT JOIN dh_profiles p ON p.id = r.profile_id
      WHERE r.id = ?
    `, [roomId])

    const voice = (profile?.tts_voice as string) || 'jack_cheng'
    const speed = (profile?.tts_speed as number) || 1.0

    const aiSettings = roomSessionService.getAiSettings(roomId)
    const queueLine = await prepareQueueLine(text, aiSettings.outputLanguage)

    const item = queueManager.insertAfterCurrent({
      text: queueLine.spokenText,
      translatedText: queueLine.translatedText,
      audioPath: null,
      source: 'manual',
      meta: { role: 'manual' }
    })

    ttsService.synthesize(voice, queueLine.spokenText, speed)
      .then(result => {
        queueManager.updateAudioPath(item.id, result.audioPath)
      })
      .catch(err => {
        queueManager.dropPendingItem(item.id, err.message)
        console.error('[LiveRoom] Manual TTS failed:', err.message)
      })

    return { ok: true, id: item.id }
  })

  // ── Link switching ────────────────────────────────────────────────────────

  ipcMain.handle('live:switch-link', async (_e, roomId: string, linkId: string | null) => {
    // Manual switch disables auto-rotation
    aiLoopService.disableAutoRotation()
    aiLoopService.clearPendingGenerated()
    roomSessionService.switchLink(roomId, linkId)
    // Immediately trigger AI generation for the new product context
    aiLoopService.triggerNow().catch(console.error)
    return { ok: true }
  })

  // ── Auto-rotation control ──────────────────────────────────────────────────

  ipcMain.handle('live:rotation-enable', async (_e, roomId: string, batchesPerProduct?: number) => {
    aiLoopService.enableAutoRotation(batchesPerProduct)
    dbRun(
      `UPDATE room_settings SET auto_rotation_enabled = 1, auto_rotation_batches = ? WHERE room_id = ?`,
      [batchesPerProduct || 1, roomId]
    )
    saveDatabase()
    return { ok: true }
  })

  ipcMain.handle('live:rotation-disable', async (_e, roomId: string) => {
    aiLoopService.disableAutoRotation()
    dbRun(
      `UPDATE room_settings SET auto_rotation_enabled = 0 WHERE room_id = ?`,
      [roomId]
    )
    saveDatabase()
    return { ok: true }
  })

  ipcMain.handle('live:rotation-status', async () => {
    return aiLoopService.getRotationState()
  })

  // ── Danmaku feed ─────────────────────────────────────────────────────────

  ipcMain.handle('live:danmaku-push', (_e, _roomId: string, event: DanmakuEvent) => {
    eventBatcher.addEvent(event)
    return { ok: true }
  })

  // ── Shortcut trigger ──────────────────────────────────────────────────────

  ipcMain.handle('live:shortcut-trigger', async (_e, roomId: string, scriptId: string) => {
    const script = dbGet(
      `SELECT content FROM scripts WHERE id = ? AND type = 'shortcut' AND room_id = ?`,
      [scriptId, roomId]
    )
    if (!script || !script.content) return { ok: false, error: 'Script not found' }

    const profile = dbGet(`
      SELECT p.tts_voice, p.tts_speed
      FROM rooms r
      LEFT JOIN dh_profiles p ON p.id = r.profile_id
      WHERE r.id = ?
    `, [roomId])

    const voice = (profile?.tts_voice as string) || 'jack_cheng'
    const speed = (profile?.tts_speed as number) || 1.0
    const sourceText = script.content as string

    const aiSettings = roomSessionService.getAiSettings(roomId)
    const queueLine = await prepareQueueLine(sourceText, aiSettings.outputLanguage)

    const item = queueManager.insertAfterCurrent({
      text: queueLine.spokenText,
      translatedText: queueLine.translatedText,
      audioPath: null,
      source: 'shortcut',
      meta: { role: 'shortcut' }
    })

    ttsService.synthesize(voice, queueLine.spokenText, speed)
      .then(result => queueManager.updateAudioPath(item.id, result.audioPath))
      .catch(err => {
        queueManager.dropPendingItem(item.id, err.message)
        console.error('[LiveRoom] Shortcut TTS failed:', err.message)
      })

    return { ok: true, id: item.id }
  })

  // ── Blacklist (real-time add) ─────────────────────────────────────────────

  ipcMain.handle('live:blacklist-add', (_e, roomId: string, platformUserId: string, note?: string) => {
    dbRun(
      'INSERT INTO blacklist (id, room_id, platform_user_id, note) VALUES (?, ?, ?, ?)',
      [uuidv4(), roomId, platformUserId, note || '']
    )
    saveDatabase()
    eventBatcher.addToBlacklist(platformUserId)
    danmakuReplyService.addToBlacklist(platformUserId)
    return { ok: true }
  })
}
