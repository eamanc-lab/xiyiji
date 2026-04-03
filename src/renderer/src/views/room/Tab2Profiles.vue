<template>
  <div class="tab-profiles">
    <div class="profile-list">
      <div class="list-header">
        <span>形象方案</span>
        <button class="btn-small" @click="startCreate">+ 新建</button>
      </div>

      <div
        v-for="p in profiles"
        :key="p.id"
        class="profile-item"
        :class="{ active: selected?.id === p.id }"
        @click="select(p)"
      >
        <div class="profile-item-name">{{ p.name }}</div>
        <div class="profile-item-sub">
          {{ mediaTypeSummary(p) }}
          · {{ p.room_count }} 个房间
        </div>
        <span v-if="p.is_default" class="default-badge">默认</span>
      </div>

      <div v-if="profiles.length === 0" class="empty-list">暂无方案</div>
    </div>

    <div v-if="selected || editing" class="profile-edit">
      <div class="edit-header">
        <span>{{ editing ? (form.id ? '编辑方案' : '新建方案') : '方案详情' }}</span>
        <div class="edit-header-actions">
          <button
            v-if="selected && !editing"
            class="btn-small"
            :class="{ active: previewing || previewBusy }"
            @click="(previewing || previewBusy) ? stopPreview() : openPreview()"
          >
            {{ previewing ? '停止' : (previewBusy ? '取消预热' : '预览') }}
          </button>

          <button v-if="selected && !editing" class="btn-small" @click="startEdit">编辑</button>

          <button
            v-if="selected && !editing"
            class="btn-small"
            :class="{ active: selected.id === currentProfileId }"
            @click="applyToRoom"
          >
            {{ selected.id === currentProfileId ? '已应用' : '应用到房间' }}
          </button>

          <button
            v-if="selected && !selected.is_default && !editing"
            class="btn-small"
            @click="setDefault"
          >
            设为默认
          </button>

          <button v-if="selected && !editing" class="btn-small danger" @click="handleDelete">
            删除
          </button>
        </div>
      </div>

      <div v-if="previewStatusText && selected && !editing" class="preview-status">
        {{ previewStatusText }}
      </div>

      <div v-if="editing" class="edit-form">
        <div class="field">
          <label>名称</label>
          <input v-model="form.name" placeholder="方案名称" />
        </div>

        <div class="field">
          <label>媒体来源</label>
          <div class="radio-group">
            <label class="radio-item" :class="{ active: form.mediaType === 'video' }">
              <input type="radio" v-model="form.mediaType" value="video" />
              <span>视频文件</span>
            </label>
            <label class="radio-item" :class="{ active: form.mediaType === 'camera' }">
              <input type="radio" v-model="form.mediaType" value="camera" />
              <span>摄像头</span>
            </label>
            <label class="radio-item" :class="{ active: form.mediaType === 'video_stream' }">
              <input type="radio" v-model="form.mediaType" value="video_stream" />
              <span>视频流式</span>
            </label>
          </div>
        </div>

        <div class="field" v-if="form.mediaType !== 'camera'">
          <label>形象视频</label>
          <select v-model="form.videoId">
            <option value="">（未选择）</option>
            <option v-for="a in assets" :key="a.id" :value="a.id">{{ a.name }}</option>
          </select>
        </div>

        <div class="field" v-if="form.mediaType === 'camera'">
          <label>摄像头设备</label>
          <div class="camera-row">
            <select v-model="form.cameraDeviceId" class="camera-select">
              <option value="">（未选择）</option>
              <option v-for="cam in cameras" :key="cam.deviceId" :value="cam.deviceId">
                {{ cam.label || ('摄像头 ' + (cameras.indexOf(cam) + 1)) }}
              </option>
            </select>
            <button class="btn-small" @click="refreshCameras">刷新</button>
          </div>
        </div>

        <div class="field">
          <div class="field-header">
            <span>绿幕抠像</span>
            <label class="toggle-switch">
              <input type="checkbox" v-model="form.chromaEnabled" />
              <span class="toggle-track"></span>
            </label>
          </div>

          <div v-if="form.chromaEnabled" class="chroma-params">
            <div class="chroma-row">
              <span class="chroma-label">相似度</span>
              <input type="range" min="0" max="100" step="1" v-model.number="form.chromaSimilarity" />
              <span class="chroma-val">{{ form.chromaSimilarity }}</span>
            </div>
            <div class="chroma-row">
              <span class="chroma-label">平滑度</span>
              <input type="range" min="0" max="5" step="1" v-model.number="form.chromaSmoothing" />
              <span class="chroma-val">{{ form.chromaSmoothing }}</span>
            </div>
          </div>
        </div>

        <div class="field">
          <label>TTS 语音</label>
          <VoiceSelector v-model="form.ttsVoice" />
        </div>

        <div class="field-row">
          <div class="field">
            <label>语速 ({{ form.ttsSpeed }}x)</label>
            <input type="range" min="0.5" max="2" step="0.1" v-model.number="form.ttsSpeed" />
          </div>
          <div class="field">
            <label>音量 ({{ form.ttsVolume }})</label>
            <input type="range" min="0" max="1" step="0.05" v-model.number="form.ttsVolume" />
          </div>
        </div>

        <div class="edit-actions">
          <button class="btn-ghost" @click="cancelEdit">取消</button>
          <button class="btn-primary" @click="handleSave">保存</button>
        </div>
      </div>

      <div v-else class="view-info">
        <div class="info-row"><span>名称</span><span>{{ selected?.name }}</span></div>
        <div class="info-row"><span>媒体来源</span><span>{{ mediaTypeLabel(selected?.media_type) }}</span></div>
        <div class="info-row" v-if="selected?.media_type !== 'camera'"><span>形象视频</span><span>{{ selected?.video_name || '未设置' }}</span></div>
        <div class="info-row" v-if="selected?.media_type === 'camera'"><span>摄像头</span><span>{{ cameraLabel(selected?.camera_device_id) }}</span></div>
        <div class="info-row"><span>绿幕抠像</span><span>{{ selected?.chroma_enabled ? `开启 (相似度=${selected.chroma_similarity}, 平滑度=${selected.chroma_smoothing})` : '关闭' }}</span></div>
        <div class="info-row"><span>TTS 语音</span><span>{{ selected?.tts_voice }}</span></div>
        <div class="info-row"><span>语速</span><span>{{ selected?.tts_speed }}x</span></div>
        <div class="info-row"><span>音量</span><span>{{ selected?.tts_volume }}</span></div>
      </div>
    </div>

    <div v-else class="no-select">请选择或新建一个方案</div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue'
import { useLiveStore } from '@/stores/live.store'
import VoiceSelector from '../../components/profile/VoiceSelector.vue'

const props = defineProps<{ roomId: string }>()
const liveStore = useLiveStore()

const profiles = ref<any[]>([])
const assets = ref<any[]>([])
const cameras = ref<MediaDeviceInfo[]>([])
const selected = ref<any>(null)
const editing = ref(false)
const currentProfileId = ref<string | null>(null)

function createBlankForm() {
  return {
    id: '',
    name: '',
    mediaType: 'video' as 'video' | 'camera' | 'video_stream',
    videoId: '',
    cameraDeviceId: '',
    cameraDeviceLabel: '',
    chromaEnabled: false,
    chromaSimilarity: 80,
    chromaSmoothing: 1,
    ttsVoice: 'jack_cheng',
    ttsSpeed: 1.0,
    ttsVolume: 0.8
  }
}

const form = ref(createBlankForm())
const previewing = ref(false)
const previewBusy = ref(false)
const previewStatusText = ref('')

type PlayerPreviewStatus = {
  token: string
  state: 'starting' | 'ready' | 'error'
  mode: 'video' | 'camera' | 'video_stream'
  avatarPath?: string
  message?: string
  videoFps?: number
  videoFrames?: number
  videoDurationSec?: number
}

type PendingPreviewContext = {
  token: string
  generation: number
  avatarPath: string
  voice: string
  speed: number
  profileName: string
  mediaType: 'video' | 'camera' | 'video_stream'
  segments: string[]
}

async function load(): Promise<void> {
  profiles.value = (await window.api.profileList()) || []
  assets.value = (await window.api.assetList()) || []
  const room = await window.api.roomGet(props.roomId)
  currentProfileId.value = room?.profile_id || null
}

async function applyToRoom(): Promise<void> {
  if (!selected.value) return
  await window.api.roomUpdate(props.roomId, { profileId: selected.value.id })
  currentProfileId.value = selected.value.id
}

async function refreshCameras(): Promise<void> {
  try {
    const tmp = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
    tmp.getTracks().forEach((t) => t.stop())
  } catch {
    // ignore permission errors in list refresh
  }
  const devices = await navigator.mediaDevices.enumerateDevices()
  cameras.value = devices.filter((d) => d.kind === 'videoinput')
}

function cameraLabel(deviceId: string | null | undefined): string {
  if (!deviceId) return '未设置'
  const label = cameraKnownLabel(deviceId)
  return label || '已配置'
}

function cameraKnownLabel(deviceId: string | null | undefined): string {
  if (!deviceId) return ''
  const cam = cameras.value.find((c) => c.deviceId === deviceId)
  return cam ? (cam.label || '摄像头') : ''
}

function mediaTypeLabel(mediaType: string | null | undefined): string {
  if (mediaType === 'camera') return '摄像头'
  if (mediaType === 'video_stream') return '视频流式'
  return '视频文件'
}

function mediaTypeSummary(profile: any): string {
  if (profile?.media_type === 'camera') return '摄像头'
  if (profile?.media_type === 'video_stream') {
    return `视频流式 · ${profile?.video_name || '未设置视频'}`
  }
  return profile?.video_name || '未设置视频'
}

function select(p: any): void {
  selected.value = p
  editing.value = false
}

function startCreate(): void {
  selected.value = null
  form.value = createBlankForm()
  editing.value = true
}

function startEdit(): void {
  if (!selected.value) return
  const p = selected.value
  form.value = {
    id: p.id,
    name: p.name,
    mediaType: (p.media_type as 'video' | 'camera' | 'video_stream') || 'video',
    videoId: p.video_id || '',
    cameraDeviceId: p.camera_device_id || '',
    cameraDeviceLabel: p.camera_device_label || cameraKnownLabel(p.camera_device_id),
    chromaEnabled: !!p.chroma_enabled,
    chromaSimilarity: p.chroma_similarity ?? 80,
    chromaSmoothing: p.chroma_smoothing ?? 1,
    ttsVoice: p.tts_voice || 'jack_cheng',
    ttsSpeed: p.tts_speed ?? 1.0,
    ttsVolume: p.tts_volume ?? 0.8
  }
  editing.value = true
}

function cancelEdit(): void {
  editing.value = false
}

async function handleSave(): Promise<void> {
  if (!form.value.name.trim()) {
    console.error('请输入方案名称')
    return
  }

  const data = {
    name: form.value.name,
    mediaType: form.value.mediaType,
    videoId: form.value.mediaType !== 'camera' ? (form.value.videoId || null) : null,
    cameraDeviceId: form.value.mediaType === 'camera' ? (form.value.cameraDeviceId || null) : null,
    cameraDeviceLabel: form.value.mediaType === 'camera'
      ? (cameraKnownLabel(form.value.cameraDeviceId) || null)
      : null,
    chromaEnabled: form.value.chromaEnabled ? 1 : 0,
    chromaSimilarity: form.value.chromaSimilarity,
    chromaSmoothing: form.value.chromaSmoothing,
    ttsVoice: form.value.ttsVoice,
    ttsSpeed: form.value.ttsSpeed,
    ttsVolume: form.value.ttsVolume
  }

  if (form.value.id) {
    const id = form.value.id
    await window.api.profileUpdate(id, data)
    editing.value = false
    await load()
    selected.value = profiles.value.find((p) => p.id === id) || null
    return
  }

  const result = await window.api.profileCreate(data)
  editing.value = false
  await load()
  const newId = result?.record?.id
  if (newId) {
    selected.value = profiles.value.find((p) => p.id === newId) || null
  }
}

async function setDefault(): Promise<void> {
  if (!selected.value) return
  await window.api.profileSetDefault(selected.value.id)
  await load()
  selected.value = profiles.value.find((p) => p.id === selected.value?.id) || selected.value
}

async function handleDelete(): Promise<void> {
  if (!selected.value) return
  if (!window.confirm(`确定删除方案「${selected.value.name}」吗？`)) return
  const result = await window.api.profileDelete(selected.value.id)
  if (result?.ok === false) {
    console.error(result.error || 'Delete failed')
    return
  }
  selected.value = null
  await load()
}

const PREVIEW_SEGMENT_LIBRARY = [
  '大家好，欢迎来到我的直播间。今天给大家带来几款精选好物，品质和价格都很有竞争力。',
  '每一款产品都经过严格筛选，数量有限，喜欢的朋友可以直接咨询。',
  '现在给大家重点看一下整体展示效果，细节和质感都非常稳定。',
  '屏幕前的朋友可以继续停留几分钟，我把不同角度和状态都完整演示一遍。',
  '这次预览会尽量连续播放，方便大家观察动作、口型和画面衔接。',
  '如果你更关注细节，可以留意嘴部、表情和头部转动是否自然。',
  '我们会把节奏放稳一点，让整段展示更接近真实直播时的状态。',
  '接下来继续展示连续片段，方便确认大视频播放时会不会出现跳变。',
  '画面中的动作、口型和整体节奏都会持续输出，不再只看很短的一小段。',
  '如果当前效果稳定，后续长视频播放时整体观感也会更接近实际直播。',
  '现在继续往后播放，观察不同时间段下的人脸位置和动作连续性。',
  '这段内容主要用于预览连贯度，方便确认是否真正从头开始顺序播放。',
  '感谢大家耐心观看预览，后面还会继续展示一段更长的连续效果。',
  '我们尽量覆盖更长时间范围，这样更容易发现跳帧、回环或者错位问题。',
  '预览即将接近尾声，感谢大家的支持与陪伴，我们下次直播再见。'
]
const PREVIEW_MIN_DURATION_SEC = 20
const PREVIEW_DEFAULT_DURATION_SEC = 180
const PREVIEW_MAX_DURATION_SEC = 0
const PREVIEW_ESTIMATED_CHARS_PER_SEC = 4.2

let stopPreviewIdle: (() => void) | null = null
let stopPreviewFailed: (() => void) | null = null
let stopPreviewStatus: (() => void) | null = null
let previewErrorShown = false
let previewSegmentCursor = 0
let previewSubmitting = false
let previewGeneration = 0
let previewConsecutiveFailures = 0
let pendingPreviewContext: PendingPreviewContext | null = null
const MAX_PREVIEW_CONSECUTIVE_FAILURES = 3

function shouldBlockPreviewPlayback(): boolean {
  return liveStore.roomStarting || liveStore.status !== 'idle'
}

function cleanupPreviewIdleHook(): void {
  if (stopPreviewIdle) {
    stopPreviewIdle()
    stopPreviewIdle = null
  }
  if (stopPreviewFailed) {
    stopPreviewFailed()
    stopPreviewFailed = null
  }
}

function cleanupPreviewStatusHook(): void {
  if (stopPreviewStatus) {
    stopPreviewStatus()
    stopPreviewStatus = null
  }
}

function reportPreviewError(message: string, detail?: unknown): void {
  if (previewErrorShown) return
  previewErrorShown = true
  if (detail) {
    console.error(`[Preview] ${message}`, detail)
  } else {
    console.error(`[Preview] ${message}`)
  }
}

function clampPreviewDuration(seconds: number): number {
  if (!Number.isFinite(seconds)) return PREVIEW_MIN_DURATION_SEC
  if (PREVIEW_MAX_DURATION_SEC > 0) {
    return Math.max(PREVIEW_MIN_DURATION_SEC, Math.min(PREVIEW_MAX_DURATION_SEC, seconds))
  }
  return Math.max(PREVIEW_MIN_DURATION_SEC, seconds)
}

function estimatePreviewSegmentDuration(text: string, speed: number): number {
  const effectiveSpeed = Math.max(0.5, Number.isFinite(speed) ? speed : 1)
  const textLength = String(text || '').trim().length
  const estimated = textLength / (PREVIEW_ESTIMATED_CHARS_PER_SEC * effectiveSpeed) + 0.8
  return Math.max(3.5, estimated)
}

function buildPreviewSegments(targetDurationSec: number, speed: number): string[] {
  const normalizedTarget = clampPreviewDuration(targetDurationSec)
  const segments: string[] = []
  let accumulated = 0
  let cursor = 0
  const maxSegments = Math.max(
    PREVIEW_SEGMENT_LIBRARY.length,
    Math.ceil(normalizedTarget / 3.5) + PREVIEW_SEGMENT_LIBRARY.length
  )
  while (accumulated < normalizedTarget && cursor < maxSegments) {
    const text = PREVIEW_SEGMENT_LIBRARY[cursor % PREVIEW_SEGMENT_LIBRARY.length]
    segments.push(text)
    accumulated += estimatePreviewSegmentDuration(text, speed)
    cursor += 1
  }
  return segments.length > 0 ? segments : [PREVIEW_SEGMENT_LIBRARY[0]]
}

function resolvePreviewSegmentsFromStatus(
  pending: PendingPreviewContext,
  status: PlayerPreviewStatus
): string[] {
  if (pending.mediaType === 'camera') {
    return pending.segments
  }

  const durationFromStatus = Number(status.videoDurationSec || 0)
  if (!Number.isFinite(durationFromStatus) || durationFromStatus <= PREVIEW_MIN_DURATION_SEC) {
    return pending.segments
  }

  const rebuiltSegments = buildPreviewSegments(durationFromStatus, pending.speed)
  console.log(
    `[Preview] native preview duration resolved: ${durationFromStatus.toFixed(1)}s, segments=${rebuiltSegments.length}`
  )
  return rebuiltSegments
}

function resolvePreviewDurationSeconds(profile: any, videoInfo: any): number {
  const detected = Number(videoInfo?.duration || 0)
  if (detected > 0) return clampPreviewDuration(detected)

  const stored = Number(profile?.video_duration_sec || 0)
  if (stored > 0) return clampPreviewDuration(stored)

  return PREVIEW_DEFAULT_DURATION_SEC
}

function finishPreviewPlayback(context: PendingPreviewContext, message: string): void {
  previewStatusText.value = message
  console.log(
    `[Preview] completed one-shot playback: submitted=${Math.min(previewSegmentCursor, context.segments.length)}/${context.segments.length}`
  )
  stopPreview({ clearStatus: false })
}

function clearPendingPreview(clearStatus: boolean = true): void {
  pendingPreviewContext = null
  if (clearStatus) {
    previewStatusText.value = ''
  }
}

function attachPreviewPlaybackHooks(context: PendingPreviewContext): void {
  stopPreviewFailed = window.api.onPipelineFailed((task: any) => {
    if (!previewing.value || context.generation !== previewGeneration) return
    previewConsecutiveFailures++
    console.warn(
      `[Preview] task failed (${previewConsecutiveFailures}/${MAX_PREVIEW_CONSECUTIVE_FAILURES}): ${task?.error || 'unknown'}`
    )
    if (previewConsecutiveFailures >= MAX_PREVIEW_CONSECUTIVE_FAILURES) {
      previewStatusText.value = `预览已停止：连续失败 ${previewConsecutiveFailures} 次`
      reportPreviewError(
        `preview stopped: ${previewConsecutiveFailures} consecutive failures, last: ${task?.error || 'unknown'}`
      )
      stopPreview({ clearStatus: false })
    }
  })

  stopPreviewIdle = window.api.onPipelineIdle(() => {
    if (!previewing.value || context.generation !== previewGeneration) return
    if (previewConsecutiveFailures >= MAX_PREVIEW_CONSECUTIVE_FAILURES) return
    if (previewSegmentCursor >= context.segments.length && !previewSubmitting) {
      finishPreviewPlayback(context, '预览已完成，窗口即将关闭')
      return
    }
    submitPreviewBatch(context).catch((err) => {
      previewStatusText.value = '预览播报提交失败，请重试'
      reportPreviewError('idle callback submit failed', err)
      stopPreview({ clearStatus: false })
    })
  })
}

async function queueRemainingPreviewSegments(context: PendingPreviewContext): Promise<void> {
  while (
    previewing.value &&
    context.generation === previewGeneration &&
    previewSegmentCursor < context.segments.length
  ) {
    await submitPreviewBatch(context)
    if (previewSegmentCursor < context.segments.length) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }
}

async function startPreviewPlayback(context: PendingPreviewContext): Promise<void> {
  if (context.generation !== previewGeneration) return
  cleanupPreviewIdleHook()
  await window.api.pipelineSetAvatar(context.avatarPath)
  if (context.generation !== previewGeneration) return

  previewing.value = true
  previewBusy.value = false
  previewStatusText.value = ''
  previewConsecutiveFailures = 0
  console.log(
    `[Preview] start voice=${context.voice} speed=${context.speed} profile=${context.profileName} mode=${context.mediaType} segments=${context.segments.length}`
  )

  attachPreviewPlaybackHooks(context)
  await submitPreviewBatch(context)
  void queueRemainingPreviewSegments(context).catch((err) => {
    if (!previewing.value || context.generation !== previewGeneration) return
    previewStatusText.value = '预览排队失败，请重试'
    reportPreviewError('background preview queue failed', err)
    stopPreview({ clearStatus: false })
  })
}

async function submitPreviewBatch(context: PendingPreviewContext): Promise<void> {
  if (!previewing.value || previewSubmitting) return
  if (shouldBlockPreviewPlayback()) {
    stopPreview()
    return
  }

  previewSubmitting = true
  try {
    if (previewSegmentCursor >= context.segments.length) {
      return
    }

    const idx = previewSegmentCursor
    previewSegmentCursor += 1
    const text = context.segments[idx]
    previewStatusText.value = `预览播放中：第 ${idx + 1}/${context.segments.length} 段`
    console.log(
      `[Preview] submit segment ${idx + 1}/${context.segments.length}: profile=${context.profileName}, mode=${context.mediaType}, text="${text.slice(0, 24)}"`
    )
    const result = await window.api.pipelineSubmitTts(text, context.voice, context.speed)
    if (result && !result.success) {
      reportPreviewError(`TTS submit failed: ${result.error || 'unknown error'}`)
      stopPreview()
    }
  } finally {
    previewSubmitting = false
  }
}

async function openPreview(): Promise<void> {
  const p = selected.value
  if (!p || previewBusy.value || previewing.value) return
  if (shouldBlockPreviewPlayback()) return

  const chromaSettings = {
    enabled: !!p.chroma_enabled,
    similarity: p.chroma_similarity ?? 80,
    smoothing: p.chroma_smoothing ?? 1
  }

  await window.api.pipelineCancel()
  cleanupPreviewIdleHook()
  previewErrorShown = false
  previewSegmentCursor = 0
  previewSubmitting = false
  previewConsecutiveFailures = 0
  previewStatusText.value = ''
  clearPendingPreview()
  const gen = ++previewGeneration
  previewBusy.value = true

  const voice = p.tts_voice || 'jack_cheng'
  const speed = p.tts_speed ?? 1.0
  const cameraSegments = buildPreviewSegments(30, speed)

  try {
    if (p.media_type === 'camera') {
      if (!p.camera_device_id) {
        previewStatusText.value = '未配置摄像头设备'
        reportPreviewError('camera device is not configured')
        stopPreview({ clearStatus: false })
        return
      }

      const camResult = await window.api.playerOpenCamera(p.camera_device_id, p.id, chromaSettings)
      if (!camResult?.success) {
        previewStatusText.value = `摄像头预览启动失败：${camResult?.error || 'unknown error'}`
        reportPreviewError(`open camera failed: ${camResult?.error || 'unknown error'}`)
        stopPreview({ clearStatus: false })
        return
      }

      if (camResult?.pendingInit && camResult?.previewToken) {
        pendingPreviewContext = {
          token: camResult.previewToken,
          generation: gen,
          avatarPath: camResult.capturedVideoPath,
          voice,
          speed,
          profileName: p.name,
          mediaType: 'camera',
          segments: cameraSegments
        }
        previewStatusText.value =
          camResult.previewMessage || '正在启动摄像头预览并预热模型，首次约需几十秒'
        return
      }

      await startPreviewPlayback({
        token: '',
        generation: gen,
        avatarPath: camResult.capturedVideoPath,
        voice,
        speed,
        profileName: p.name,
        mediaType: 'camera',
        segments: cameraSegments
      })
      return
    } else {
      if (!p.video_file_path) {
        previewStatusText.value = '未配置形象视频'
        reportPreviewError('video file is not configured')
        stopPreview({ clearStatus: false })
        return
      }

      const videoInfo = await window.api.getVideoInfo(p.video_file_path)
      const previewDurationSec = resolvePreviewDurationSeconds(p, videoInfo)
      const segments = buildPreviewSegments(previewDurationSec, speed)

      const openResult =
        p.media_type === 'video_stream'
          ? await window.api.playerOpenVideoStream(p.video_file_path, chromaSettings)
          : await window.api.playerOpen([p.video_file_path], chromaSettings)
      if (openResult?.pendingInit && openResult?.previewToken) {
        pendingPreviewContext = {
          token: openResult.previewToken,
          generation: gen,
          avatarPath: p.video_file_path,
          voice,
          speed,
          profileName: p.name,
          mediaType: p.media_type === 'video_stream' ? 'video_stream' : 'video',
          segments
        }
        previewStatusText.value =
          openResult.previewMessage || '正在预热预览，首次需要分析参考视频。大型视频首次可能需要数分钟，请勿重复点击。'
        return
      }

      await startPreviewPlayback({
        token: '',
        generation: gen,
        avatarPath: p.video_file_path,
        voice,
        speed,
        profileName: p.name,
        mediaType: p.media_type === 'video_stream' ? 'video_stream' : 'video',
        segments
      })
      return
    }
  } catch (err: any) {
    previewStatusText.value = `预览启动失败：${err?.message || err}`
    reportPreviewError(`open preview failed: ${err?.message || err}`, err)
    stopPreview({ clearStatus: false })
  }
}

async function handlePlayerPreviewStatus(status: PlayerPreviewStatus): Promise<void> {
  const pending = pendingPreviewContext
  if (!pending || status.token !== pending.token) return
  if (pending.generation !== previewGeneration) return

  if (status.state === 'starting') {
    previewStatusText.value = status.message || previewStatusText.value
    return
  }

  if (status.state === 'error') {
    clearPendingPreview(false)
    previewStatusText.value = `预览启动失败：${status.message || 'unknown error'}`
    reportPreviewError(`native preview init failed: ${status.message || 'unknown error'}`)
    stopPreview({ clearStatus: false, closePlayer: false })
    return
  }

  clearPendingPreview()
  try {
    await startPreviewPlayback({
      ...pending,
      avatarPath: status.avatarPath || pending.avatarPath,
      segments: resolvePreviewSegmentsFromStatus(pending, status)
    })
  } catch (err: any) {
    previewStatusText.value = `预览启动失败：${err?.message || err}`
    reportPreviewError(`finalize preview failed: ${err?.message || err}`, err)
    stopPreview({ clearStatus: false })
  }
}

async function syncCameraProfileLabels(): Promise<void> {
  const updates = profiles.value
    .filter((p) => p.media_type === 'camera' && p.camera_device_id)
    .map(async (p) => {
      const label = cameraKnownLabel(p.camera_device_id)
      if (!label || label === p.camera_device_label) return
      await window.api.profileUpdate(p.id, { cameraDeviceLabel: label })
      p.camera_device_label = label
      if (selected.value?.id === p.id) {
        selected.value = { ...selected.value, camera_device_label: label }
      }
    })

  await Promise.all(updates)
}

function stopPreview(options: { clearStatus?: boolean; closePlayer?: boolean } = {}): void {
  const { clearStatus = true, closePlayer = true } = options
  previewing.value = false
  previewBusy.value = false
  previewSubmitting = false
  previewConsecutiveFailures = 0
  cleanupPreviewIdleHook()
  clearPendingPreview(clearStatus)
  if (closePlayer) {
    window.api.playerClose().catch((err) => {
      console.warn('[Preview] playerClose failed', err)
    })
  }
  window.api.pipelineCancel().catch((err) => {
    console.warn('[Preview] pipelineCancel failed', err)
  })
}

onMounted(async () => {
  cleanupPreviewStatusHook()
  stopPreviewStatus = window.api.onPlayerPreviewStatus((status: PlayerPreviewStatus) => {
    handlePlayerPreviewStatus(status).catch((err) => {
      previewStatusText.value = `预览状态处理失败：${err?.message || err}`
      reportPreviewError('player preview status handling failed', err)
      stopPreview({ clearStatus: false })
    })
  })
  await load()
  await refreshCameras()
  await syncCameraProfileLabels()
})

watch(
  () => [liveStore.roomStarting, liveStore.status] as const,
  ([roomStarting, status]) => {
    if ((roomStarting || status !== 'idle') && (previewing.value || previewBusy.value)) {
      console.log('[Preview] stopping because live room startup/session is active')
      stopPreview()
    }
  }
)

onUnmounted(() => {
  if (previewing.value || previewBusy.value) stopPreview()
  cleanupPreviewStatusHook()
})
</script>
<style scoped>
.tab-profiles { display: flex; height: 100%; overflow: hidden; }

/* 鈹€鈹€ List 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€ */
.profile-list {
  width: 240px;
  background: #f8f8fa;
  border-right: 1px solid #e4e4e7;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  overflow-y: auto;
}

.list-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  font-size: 13px;
  color: #71717a;
  border-bottom: 1px solid #e4e4e7;
  flex-shrink: 0;
}

.profile-item {
  padding: 12px 16px;
  cursor: pointer;
  border-bottom: 1px solid #f0f0f2;
  position: relative;
  transition: background 0.15s;
}
.profile-item:hover { background: #f0f0f2; }
.profile-item.active { background: #eff6ff; }
.profile-item-name { font-size: 13px; color: #18181b; }
.profile-item-sub { font-size: 11px; color: #a1a1aa; margin-top: 3px; }
.default-badge { position: absolute; top: 8px; right: 10px; font-size: 10px; color: #4a9eff; }
.empty-list { padding: 20px 16px; color: #a1a1aa; font-size: 12px; }

/* 鈹€鈹€ Edit panel 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€ */
.profile-edit {
  flex: 1;
  padding: 20px;
  overflow-y: auto;
  background: #ffffff;
}

.no-select {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #a1a1aa;
  font-size: 14px;
  background: #ffffff;
}

.edit-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 20px;
  font-size: 15px;
  font-weight: 600;
  color: #18181b;
}
.edit-header-actions { display: flex; gap: 8px; }
.preview-status {
  margin: -8px 0 16px;
  padding: 10px 12px;
  border-radius: 8px;
  background: #fff7ed;
  border: 1px solid #fed7aa;
  color: #9a3412;
  font-size: 12px;
  line-height: 1.5;
}

/* 鈹€鈹€ Form 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€ */
.edit-form { display: flex; flex-direction: column; gap: 18px; }

.field > label,
.field-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  color: #71717a;
  margin-bottom: 8px;
}

.field input[type="text"],
.field input:not([type]),
.field select {
  width: 100%;
  padding: 8px 12px;
  background: #f9f9fb;
  border: 1px solid #e4e4e7;
  border-radius: 6px;
  color: #18181b;
  font-size: 14px;
  outline: none;
  box-sizing: border-box;
}
.field input:focus, .field select:focus { border-color: #4a9eff; }
.field input[type="range"] { padding: 0; background: transparent; border: none; width: 100%; }

/* Radio group */
.radio-group {
  display: flex;
  gap: 12px;
}
.radio-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 16px;
  border: 1px solid #e4e4e7;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  color: #71717a;
  background: #f9f9fb;
  transition: border-color 0.15s, background 0.15s;
  user-select: none;
}
.radio-item input[type="radio"] { display: none; }
.radio-item.active {
  border-color: #4a9eff;
  background: #eff6ff;
  color: #2563eb;
  font-weight: 500;
}

/* Camera row */
.camera-row { display: flex; gap: 8px; align-items: center; }
.camera-select { flex: 1; }

/* Toggle switch */
.toggle-switch {
  position: relative;
  display: inline-block;
  width: 36px;
  height: 20px;
  flex-shrink: 0;
}
.toggle-switch input { display: none; }
.toggle-track {
  position: absolute;
  inset: 0;
  background: #d4d4d8;
  border-radius: 10px;
  cursor: pointer;
  transition: background 0.2s;
}
.toggle-track::after {
  content: '';
  position: absolute;
  top: 3px;
  left: 3px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #ffffff;
  transition: transform 0.2s;
}
.toggle-switch input:checked + .toggle-track { background: #4a9eff; }
.toggle-switch input:checked + .toggle-track::after { transform: translateX(16px); }

/* Chroma params */
.chroma-params {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  background: #f5f9ff;
  border: 1px solid #dbeafe;
  border-radius: 8px;
}
.chroma-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.chroma-label { font-size: 12px; color: #71717a; width: 44px; flex-shrink: 0; }
.chroma-row input[type="range"] { flex: 1; accent-color: #4a9eff; }
.chroma-val { font-size: 12px; color: #18181b; width: 20px; text-align: right; flex-shrink: 0; }

/* Field row */
.field-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.edit-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 4px; }

/* View info */
.view-info { display: flex; flex-direction: column; gap: 0; }
.info-row {
  display: flex;
  justify-content: space-between;
  font-size: 14px;
  padding: 10px 0;
  border-bottom: 1px solid #f0f0f2;
}
.info-row span:first-child { color: #71717a; }
.info-row span:last-child { color: #18181b; }

/* Buttons */
.btn-small { font-size: 12px; padding: 4px 10px; border: 1px solid #e4e4e7; border-radius: 4px; background: transparent; color: #71717a; cursor: pointer; }
.btn-small:hover { color: #18181b; border-color: #a1a1aa; }
.btn-small.danger:hover { color: #dc2626; border-color: #dc2626; }
.btn-small.active { color: #dc2626; border-color: #dc2626; background: #fff0f0; }
.btn-primary { padding: 8px 20px; background: #4a9eff; border: none; border-radius: 6px; color: #fff; font-size: 14px; cursor: pointer; }
.btn-primary:hover { background: #3a8ef0; }
.btn-ghost { padding: 8px 20px; background: transparent; border: 1px solid #e4e4e7; border-radius: 6px; color: #71717a; font-size: 14px; cursor: pointer; }
.btn-ghost:hover { color: #18181b; border-color: #a1a1aa; }

</style>
