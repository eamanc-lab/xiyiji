import { defineStore } from 'pinia'
import { ref } from 'vue'

export type AudioMode = 'mic' | 'file' | 'tts'

export interface PlaylistItemMeta {
  role?: 'mainline' | 'interaction' | 'manual' | 'shortcut'
  aiMode?: string | null
  scriptSourceKey?: string | null
  sequenceIndex?: number | null
  sequenceTotal?: number | null
  round?: number | null
}

export interface PlaylistItem {
  id: string
  text: string
  translatedText?: string | null
  audioPath: string | null
  source: 'ai' | 'shortcut' | 'manual'
  meta?: PlaylistItemMeta | null
  status: 'pending' | 'ready' | 'playing' | 'buffered' | 'done' | 'dropped'
  insertedAt: number
  isAudible?: boolean
}

export interface DanmakuMessage {
  id: string
  type: 'comment' | 'gift' | 'follow' | 'enter'
  userId: string
  nickname: string
  content: string
  timestamp: number
}

export const useLiveStore = defineStore('live', () => {
  const roomId = ref<string>('')
  const status = ref<'idle' | 'running' | 'paused'>('idle')
  const roomStarting = ref(false)
  const queue = ref<PlaylistItem[]>([])
  const danmakuList = ref<DanmakuMessage[]>([])
  const activeLinkId = ref<string | null>(null)

  // ── Video / Camera / Audio toggle state ──────────────────────────────────
  const videoRunning = ref(false)
  const videoStarting = ref(false)
  const cameraRunning = ref(false)
  const cameraStarting = ref(false)
  const audioRunning = ref(false)
  const audioStarting = ref(false)

  // ── Audio input state ────────────────────────────────────────────────────
  const audioMode = ref<AudioMode>('tts')
  const ttsText = ref('')
  const ttsVoice = ref('jack_cheng')
  const ttsSpeed = ref(1.0)
  const audioFilePath = ref('')
  const selectedMicId = ref('')

  // ── Pipeline status ──────────────────────────────────────────────────────
  const pipelineStatus = ref<'idle' | 'submitting' | 'processing' | 'playing'>('idle')
  const chunkIndex = ref(0)
  const chunkTotal = ref(0)
  const currentPipelineTask = ref<any>(null)
  const pipelineError = ref<string | null>(null)

  // ── Pipeline event listeners ─────────────────────────────────────────────
  let unsubUpdate: (() => void) | null = null
  let unsubCompleted: (() => void) | null = null
  let unsubFailed: (() => void) | null = null
  let unsubIdle: (() => void) | null = null
  let unsubBusy: (() => void) | null = null
  let unsubChunk: (() => void) | null = null
  let unsubPlayback: (() => void) | null = null

  function initPipelineListeners(): void {
    destroyPipelineListeners()

    unsubUpdate = window.api.onPipelineUpdate((task) => {
      currentPipelineTask.value = task
      if (task.status === 'processing') {
        pipelineStatus.value = 'processing'
      } else if (task.status === 'queued') {
        pipelineStatus.value = 'submitting'
      }
      pipelineError.value = null
    })

    unsubCompleted = window.api.onPipelineCompleted((task) => {
      currentPipelineTask.value = task
      pipelineStatus.value = 'playing'
    })

    unsubFailed = window.api.onPipelineFailed((task) => {
      currentPipelineTask.value = task
      pipelineError.value = task.error || '合成失败'
      pipelineStatus.value = 'idle'
      audioStarting.value = false
    })

    unsubIdle = window.api.onPipelineIdle(() => {
      pipelineStatus.value = 'idle'
      currentPipelineTask.value = null
      chunkIndex.value = 0
      chunkTotal.value = 0
      audioStarting.value = false
    })

    unsubBusy = window.api.onPipelineBusy(() => {
      pipelineStatus.value = 'processing'
    })

    unsubChunk = window.api.onChunkReady((_task, idx, total) => {
      chunkIndex.value = idx + 1
      chunkTotal.value = total
      pipelineStatus.value = 'processing'
    })

    unsubPlayback = window.api.onPlaybackFinished(() => {
      pipelineStatus.value = 'idle'
    })
  }

  function destroyPipelineListeners(): void {
    unsubUpdate?.()
    unsubCompleted?.()
    unsubFailed?.()
    unsubIdle?.()
    unsubBusy?.()
    unsubChunk?.()
    unsubPlayback?.()
    unsubUpdate = null
    unsubCompleted = null
    unsubFailed = null
    unsubIdle = null
    unsubBusy = null
    unsubChunk = null
    unsubPlayback = null
  }

  // ── Setters ──────────────────────────────────────────────────────────────
  function setVideoRunning(val: boolean): void {
    videoRunning.value = val
    videoStarting.value = false
  }

  function setCameraRunning(val: boolean): void {
    cameraRunning.value = val
    cameraStarting.value = false
  }

  function setAudioRunning(val: boolean): void {
    audioRunning.value = val
    audioStarting.value = false
  }

  function setAudioMode(mode: AudioMode): void {
    audioMode.value = mode
  }

  // ── Auto-rotation state ─────────────────────────────────────────────────
  const autoRotationEnabled = ref(false)
  const autoRotationCurrentLink = ref<string | null>(null)
  const autoRotationInterrupted = ref(false)
  const autoRotationInterruptedBy = ref<string | undefined>(undefined)
  const autoRotationBatchProgress = ref(0)
  const autoRotationBatchTotal = ref(1)

  async function enableAutoRotation(batchesPerProduct: number = 1): Promise<void> {
    await window.api.liveRotationEnable(roomId.value, batchesPerProduct)
    autoRotationEnabled.value = true
  }

  async function disableAutoRotation(): Promise<void> {
    await window.api.liveRotationDisable(roomId.value)
    autoRotationEnabled.value = false
    autoRotationInterrupted.value = false
  }

  // ── Room-level control (existing) ────────────────────────────────────────
  let unsubQueue: (() => void) | null = null
  let unsubDanmaku: (() => void) | null = null
  let unsubRotation: (() => void) | null = null

  function startListening(activeRoomId: string): void {
    roomId.value = activeRoomId
    unsubQueue = window.api.onQueueUpdate((q) => { queue.value = q })
    unsubDanmaku = window.api.onDanmakuMessage((msg) => {
      danmakuList.value.unshift({
        id: `${Date.now()}-${Math.random()}`,
        type: msg.type || 'comment',
        userId: msg.userId || '',
        nickname: msg.nickname || msg.userName || '',
        content: msg.content || msg.text || '',
        timestamp: msg.timestamp || Date.now()
      })
      if (danmakuList.value.length > 200) {
        danmakuList.value = danmakuList.value.slice(0, 200)
      }
    })
    unsubRotation = window.api.onRotationUpdate((update: any) => {
      autoRotationEnabled.value = update.enabled
      autoRotationCurrentLink.value = update.currentLinkId
      autoRotationInterrupted.value = update.isInterrupted
      autoRotationInterruptedBy.value = update.interruptedBy
      autoRotationBatchProgress.value = update.batchProgress
      autoRotationBatchTotal.value = update.batchTotal
      // Sync activeLinkId so UI highlights the right link
      if (update.enabled && update.currentLinkId) {
        activeLinkId.value = update.currentLinkId
      }
    })
  }

  function stopListening(): void {
    unsubQueue?.()
    unsubDanmaku?.()
    unsubRotation?.()
    unsubQueue = null
    unsubDanmaku = null
    unsubRotation = null
    queue.value = []
    danmakuList.value = []
    status.value = 'idle'
    activeLinkId.value = null
    autoRotationEnabled.value = false
    autoRotationInterrupted.value = false
  }

  async function collectCameraHints(): Promise<Array<{ deviceId: string; label: string }>> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return []

    try {
      let devices = await navigator.mediaDevices.enumerateDevices()
      let videoInputs = devices.filter((d) => d.kind === 'videoinput')

      if (videoInputs.length > 0 && videoInputs.some((d) => !d.label)) {
        try {
          const tmp = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
          tmp.getTracks().forEach((track) => track.stop())
          devices = await navigator.mediaDevices.enumerateDevices()
          videoInputs = devices.filter((d) => d.kind === 'videoinput')
        } catch {
          // Ignore permission failures and keep the best hints we have.
        }
      }

      return videoInputs
        .filter((d) => !!d.deviceId)
        .map((d) => ({ deviceId: d.deviceId, label: d.label || '' }))
    } catch {
      return []
    }
  }

  async function start(activeRoomId: string): Promise<{ ok: boolean; error?: string }> {
    let preparedNativeLiveStart = false
    let result: any

    try {
      const prepareResult = await window.api.playerPrepareLiveStart?.()
      preparedNativeLiveStart = !!prepareResult?.nativeRenderer
    } catch (err) {
      console.warn('[Live] playerPrepareLiveStart failed', err)
    }

    roomStarting.value = true
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    try {
      const cameraHints = await collectCameraHints()
      result = await window.api.liveRoomStart(activeRoomId, { cameraHints })
      if (result?.ok !== false) {
        status.value = 'running'
        startListening(activeRoomId)
        if (result?.rendererMode !== 'native') {
          const avatarPath = result?.avatarVideoPath
          if (avatarPath) {
            await window.api.playerOpen([avatarPath])
          } else {
            await window.api.playerOpen([])
          }
        }
      }
      return result
    } finally {
      roomStarting.value = false
      if (preparedNativeLiveStart && (!result || result.ok === false)) {
        try {
          await window.api.playerAbortLiveStart?.()
        } catch (err) {
          console.warn('[Live] playerAbortLiveStart failed', err)
        }
      }
    }
  }

  async function stop(): Promise<void> {
    await window.api.liveRoomStop(roomId.value)
    stopListening()
  }

  async function pause(): Promise<void> {
    await window.api.liveRoomPause(roomId.value)
    status.value = 'paused'
  }

  async function resume(): Promise<void> {
    await window.api.liveRoomResume(roomId.value)
    status.value = 'running'
  }

  async function switchLink(linkId: string | null): Promise<void> {
    // Manual switch disables auto-rotation
    autoRotationEnabled.value = false
    autoRotationInterrupted.value = false
    activeLinkId.value = linkId
    await window.api.liveSwitchLink(roomId.value, linkId)
  }

  async function skipCurrent(): Promise<void> { await window.api.liveQueueSkip(roomId.value) }
  async function clearQueue(): Promise<void> { await window.api.liveQueueClear(roomId.value) }
  async function sendManual(text: string): Promise<void> { await window.api.liveQueueManual(roomId.value, text) }
  async function triggerShortcut(scriptId: string): Promise<void> { await window.api.liveShortcutTrigger(roomId.value, scriptId) }

  return {
    // Room state
    roomId, status, roomStarting, queue, danmakuList, activeLinkId,
    start, stop, pause, resume, switchLink,
    skipCurrent, clearQueue, sendManual, triggerShortcut,

    // Auto-rotation
    autoRotationEnabled, autoRotationCurrentLink,
    autoRotationInterrupted, autoRotationInterruptedBy,
    autoRotationBatchProgress, autoRotationBatchTotal,
    enableAutoRotation, disableAutoRotation,

    // Video/Camera/Audio toggle state
    videoRunning, videoStarting,
    cameraRunning, cameraStarting,
    audioRunning, audioStarting,
    setVideoRunning, setCameraRunning, setAudioRunning,

    // Audio input state
    audioMode, ttsText, ttsVoice, ttsSpeed, audioFilePath, selectedMicId,
    setAudioMode,

    // Pipeline status
    pipelineStatus, chunkIndex, chunkTotal, currentPipelineTask, pipelineError,
    initPipelineListeners, destroyPipelineListeners
  }
})
