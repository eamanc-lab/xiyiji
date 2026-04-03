<template>
  <div class="voice-selector">
    <div class="voice-current">
      <span class="current-name">{{ currentName }}</span>
      <button class="btn-choose" @click="openModal">选择音色</button>
    </div>

    <teleport to="body">
      <div v-if="open" class="vs-mask" @click.self="closeModal">
        <div class="vs-dialog">
          <div class="vs-header">
            <span class="vs-title">选择音色</span>
            <button class="vs-close" @click="closeModal">×</button>
          </div>

          <div class="vs-tabs">
            <button :class="['vs-tab', { active: tab === 'preset' }]" @click="tab = 'preset'">
              预设音色
            </button>
            <button :class="['vs-tab', { active: tab === 'cloned' }]" @click="switchToCloned">
              克隆音色
            </button>
          </div>

          <!-- Preset voices -->
          <div v-if="tab === 'preset'" class="vs-list">
            <div
              v-for="v in PRESET_VOICES"
              :key="v.id"
              class="vs-item"
              :class="{ selected: modelValue === v.id }"
              @click="select(v.id)"
            >
              <div class="vs-item-info">
                <span class="vs-item-name">{{ v.name }}</span>
                <span class="vs-item-id">{{ v.id }}</span>
              </div>
              <div class="vs-item-actions">
                <button
                  class="btn-preview"
                  :disabled="previewing === v.id"
                  @click.stop="preview(v.id)"
                >{{ previewing === v.id ? '试听中…' : '试听' }}</button>
                <span v-if="modelValue === v.id" class="check-badge">✓ 已选</span>
              </div>
            </div>
          </div>

          <!-- Cloned voices -->
          <div v-if="tab === 'cloned'" class="vs-cloned">
            <!-- Recording panel -->
            <div class="record-panel">
              <input
                ref="fileInput"
                type="file"
                accept="audio/*"
                style="display:none"
                @change="handleFilePick"
              />
              <div class="record-header">
                <span class="record-hint">建议使用 10~30 秒清晰人声</span>
                <div class="record-controls">
                  <button
                    v-if="!recording && !recordedBlob && !pickedFile"
                    class="btn-file-import"
                    @click="fileInput!.click()"
                  >↑ 上传文件</button>
                  <button
                    v-if="!recording && !recordedBlob && !pickedFile"
                    class="btn-record"
                    @click="startRecord"
                  >● 录音</button>
                  <button
                    v-if="recording"
                    class="btn-record-stop"
                    @click="stopRecord"
                  >■ 停止录音</button>
                </div>
              </div>
              <div v-if="recording" class="recording-status">
                <span class="rec-dot" />
                录制中… {{ recordDuration }}s
              </div>
              <div v-if="recordedBlob || pickedFile" class="recorded-section">
                <audio :src="activeAudioUrl" controls class="audio-preview" />
                <div class="upload-form">
                  <input
                    v-model="newVoiceName"
                    class="name-input"
                    placeholder="为此音色命名"
                    maxlength="30"
                  />
                  <button
                    class="btn-upload"
                    :disabled="uploading || !newVoiceName.trim()"
                    @click="uploadVoice"
                  >{{ uploading ? '上传中…' : '保存音色' }}</button>
                  <button class="btn-discard" @click="discardAll">重新选择</button>
                </div>
              </div>
            </div>

            <!-- Cloned voice list -->
            <div v-if="loadingCloned" class="vs-loading">加载中…</div>
            <div v-else class="vs-list">
              <div
                v-for="v in clonedVoices"
                :key="v.id"
                class="vs-item"
                :class="{ selected: modelValue === v.id }"
                @click="select(v.id)"
              >
                <div class="vs-item-info">
                  <span class="vs-item-name">{{ v.name }}</span>
                  <span v-if="v.expires_in_days" class="vs-item-id">剩余 {{ v.expires_in_days }} 天</span>
                </div>
                <div class="vs-item-actions">
                  <button
                    class="btn-preview"
                    :disabled="previewing === v.id"
                    @click.stop="preview(v.id)"
                  >{{ previewing === v.id ? '试听中…' : '试听' }}</button>
                  <button class="btn-delete" @click.stop="handleDelete(v.id)">删除</button>
                  <span v-if="modelValue === v.id" class="check-badge">✓ 已选</span>
                </div>
              </div>
              <div v-if="clonedVoices.length === 0" class="vs-empty">
                暂无克隆音色，录音或上传文件后可创建
              </div>
            </div>
          </div>

          <div class="vs-footer">
            <button class="btn-confirm" @click="closeModal">确定</button>
          </div>
        </div>
      </div>
    </teleport>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'

// Inline preset list (mirrors tts.service.ts PRESET_VOICES)
const PRESET_VOICES = [
  { id: 'sales_voice', name: '销售之声 - 男声·推荐直播' },
  { id: 'jack_cheng', name: '程杰 - 男声·成熟稳重' },
  { id: 'crystla_liu', name: '晶晶 - 女声·温柔甜美' },
  { id: 'stephen_chow', name: '星爷风 - 男声·幽默' },
  { id: 'xiaoyueyue', name: '小岳岳风 - 男声·亲和' },
  { id: 'entertain', name: '娱乐 - 综艺风格' },
  { id: 'novel', name: '小说 - 有声书风格' },
  { id: 'movie', name: '电影 - 影视解说风格' },
  { id: 'mkas', name: 'MKAS - 特色音色' }
]

const props = defineProps<{ modelValue: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const open = ref(false)
const tab = ref<'preset' | 'cloned'>('preset')
const previewing = ref<string | null>(null)
const clonedVoices = ref<any[]>([])
const loadingCloned = ref(false)

// Recording state
const recording = ref(false)
const recordDuration = ref(0)
const recordedBlob = ref<Blob | null>(null)
const recordedUrl = ref('')
const newVoiceName = ref('')
const uploading = ref(false)
let mediaRecorder: MediaRecorder | null = null
let recordChunks: Blob[] = []
let durationTimer: ReturnType<typeof setInterval> | null = null
let previewAudio: HTMLAudioElement | null = null

// File import state
const fileInput = ref<HTMLInputElement | null>(null)
const pickedFile = ref<File | null>(null)
const pickedFileUrl = ref('')
const activeAudioUrl = computed(() => recordedUrl.value || pickedFileUrl.value)

const currentName = computed(() => {
  const all = [...PRESET_VOICES, ...clonedVoices.value]
  const found = all.find((v) => v.id === props.modelValue)
  return found?.name || props.modelValue || '（未选择）'
})

function openModal() {
  open.value = true
  tab.value = 'preset'
}

function closeModal() {
  open.value = false
  if (previewAudio) {
    previewAudio.pause()
    previewAudio = null
  }
  previewing.value = null
}

function select(id: string) {
  emit('update:modelValue', id)
}

async function preview(voiceId: string) {
  if (previewing.value) return
  previewing.value = voiceId
  try {
    const result = await window.api.ttsSynthesize('你好，欢迎来到我们的直播间！', voiceId, 1.0)
    if (result?.success && result.audioData) {
      if (previewAudio) previewAudio.pause()
      // Use Blob URL instead of file:// to avoid webSecurity restrictions
      const blob = new Blob([new Uint8Array(result.audioData)], { type: 'audio/wav' })
      const blobUrl = URL.createObjectURL(blob)
      previewAudio = new Audio(blobUrl)
      previewAudio.addEventListener('ended', () => {
        URL.revokeObjectURL(blobUrl)
        previewing.value = null
      })
      previewAudio.addEventListener('error', () => {
        URL.revokeObjectURL(blobUrl)
        alert('音频播放失败，请检查音色配置')
        previewing.value = null
      })
      await previewAudio.play()
    } else {
      alert('试听失败：' + (result?.error || '音色不可用，请检查TTS配置'))
      previewing.value = null
    }
  } catch (err: any) {
    alert('试听失败：' + (err?.message || '未知错误'))
    previewing.value = null
  }
}

async function switchToCloned() {
  tab.value = 'cloned'
  await loadCloned()
}

async function loadCloned() {
  loadingCloned.value = true
  try {
    const result = await window.api.ttsVoices()
    const presetIds = new Set(PRESET_VOICES.map((v) => v.id))
    clonedVoices.value = (result?.voices || []).filter((v: any) => !presetIds.has(v.id))
  } finally {
    loadingCloned.value = false
  }
}

async function startRecord() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    mediaRecorder = new MediaRecorder(stream)
    recordChunks = []
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordChunks.push(e.data)
    }
    mediaRecorder.onstop = () => {
      recordedBlob.value = new Blob(recordChunks, { type: 'audio/webm' })
      recordedUrl.value = URL.createObjectURL(recordedBlob.value)
      stream.getTracks().forEach((t) => t.stop())
    }
    mediaRecorder.start()
    recording.value = true
    recordDuration.value = 0
    durationTimer = setInterval(() => { recordDuration.value++ }, 1000)
  } catch (err: any) {
    alert('无法访问麦克风：' + err.message)
  }
}

function stopRecord() {
  if (mediaRecorder && recording.value) {
    mediaRecorder.stop()
    recording.value = false
    if (durationTimer) clearInterval(durationTimer)
  }
}

function discardAll() {
  if (recordedUrl.value) URL.revokeObjectURL(recordedUrl.value)
  if (pickedFileUrl.value) URL.revokeObjectURL(pickedFileUrl.value)
  recordedBlob.value = null
  recordedUrl.value = ''
  pickedFile.value = null
  pickedFileUrl.value = ''
  newVoiceName.value = ''
}

function handleFilePick(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  discardAll()
  pickedFile.value = file
  pickedFileUrl.value = URL.createObjectURL(file)
  // Pre-fill name from filename (strip extension)
  newVoiceName.value = file.name.replace(/\.[^/.]+$/, '')
  // Reset so the same file can be re-picked if needed
  if (fileInput.value) fileInput.value.value = ''
}

async function uploadVoice() {
  const blob = recordedBlob.value || pickedFile.value
  if (!blob || !newVoiceName.value.trim()) return
  uploading.value = true
  try {
    const arrayBuffer = await blob.arrayBuffer()
    const result = await window.api.ttsUploadVoice(
      newVoiceName.value.trim(),
      arrayBuffer,
      pickedFile.value?.name
    )
    if (result?.ok) {
      discardAll()
      await loadCloned()
    } else {
      alert(result?.error || '上传失败，请检查 TTS 配置')
    }
  } finally {
    uploading.value = false
  }
}

async function handleDelete(voiceId: string) {
  if (!confirm('确认删除此克隆音色？')) return
  const result = await window.api.ttsDeleteVoice(voiceId)
  if (result?.ok === false) {
    alert(result.error || '删除失败')
  } else {
    clonedVoices.value = clonedVoices.value.filter((v) => v.id !== voiceId)
    if (props.modelValue === voiceId) emit('update:modelValue', '')
  }
}
</script>

<style scoped>
.voice-selector { display: flex; align-items: center; }

.voice-current {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 12px;
  background: #f9f9fb;
  border: 1px solid #e4e4e7;
  border-radius: 6px;
}

.current-name { flex: 1; font-size: 14px; color: #18181b; }

.btn-choose {
  padding: 4px 12px;
  background: #4a9eff;
  border: none;
  border-radius: 4px;
  color: #fff;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
}
.btn-choose:hover { background: #3a8ef0; }

/* Modal */
.vs-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.vs-dialog {
  background: #ffffff;
  border-radius: 12px;
  width: 560px;
  max-width: 96vw;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.16);
  overflow: hidden;
}

.vs-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid #e4e4e7;
  flex-shrink: 0;
}

.vs-title { font-size: 16px; font-weight: 600; color: #18181b; }

.vs-close {
  width: 28px;
  height: 28px;
  border: none;
  background: #f4f4f5;
  border-radius: 6px;
  font-size: 16px;
  color: #71717a;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}
.vs-close:hover { background: #e4e4e7; color: #18181b; }

.vs-tabs {
  display: flex;
  padding: 0 20px;
  border-bottom: 1px solid #e4e4e7;
  flex-shrink: 0;
}

.vs-tab {
  padding: 10px 16px;
  border: none;
  background: transparent;
  border-bottom: 2px solid transparent;
  color: #71717a;
  font-size: 13px;
  cursor: pointer;
  margin-bottom: -1px;
  transition: all 0.15s;
}
.vs-tab:hover { color: #18181b; }
.vs-tab.active { color: #4a9eff; border-bottom-color: #4a9eff; }

.vs-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px 0;
}

.vs-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 20px;
  cursor: pointer;
  transition: background 0.1s;
  gap: 12px;
}
.vs-item:hover { background: #f9f9fb; }
.vs-item.selected { background: #eff6ff; }

.vs-item-info { flex: 1; min-width: 0; }
.vs-item-name { display: block; font-size: 14px; color: #18181b; }
.vs-item-id { display: block; font-size: 11px; color: #a1a1aa; font-family: monospace; margin-top: 2px; }

.vs-item-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }

.btn-preview {
  padding: 4px 10px;
  background: transparent;
  border: 1px solid #e4e4e7;
  border-radius: 4px;
  color: #71717a;
  font-size: 12px;
  cursor: pointer;
}
.btn-preview:hover:not(:disabled) { color: #18181b; border-color: #a1a1aa; }
.btn-preview:disabled { opacity: 0.5; cursor: not-allowed; }

.btn-delete {
  padding: 4px 10px;
  background: transparent;
  border: 1px solid #e4e4e7;
  border-radius: 4px;
  color: #71717a;
  font-size: 12px;
  cursor: pointer;
}
.btn-delete:hover { color: #dc2626; border-color: #dc2626; }

.check-badge {
  font-size: 11px;
  color: #4a9eff;
  font-weight: 600;
  white-space: nowrap;
}

.vs-empty {
  padding: 24px 20px;
  font-size: 13px;
  color: #a1a1aa;
  text-align: center;
}

.vs-loading {
  padding: 24px 20px;
  font-size: 13px;
  color: #71717a;
  text-align: center;
}

/* Cloned tab */
.vs-cloned {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.record-panel {
  padding: 14px 20px;
  border-bottom: 1px solid #f0f0f2;
  flex-shrink: 0;
  background: #fafafa;
}

.record-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.record-hint { font-size: 12px; color: #71717a; }

.record-controls { display: flex; gap: 8px; }

.btn-record {
  padding: 6px 14px;
  background: #dc2626;
  border: none;
  border-radius: 6px;
  color: #fff;
  font-size: 12px;
  cursor: pointer;
}
.btn-record:hover { background: #b91c1c; }

.btn-record-stop {
  padding: 6px 14px;
  background: #71717a;
  border: none;
  border-radius: 6px;
  color: #fff;
  font-size: 12px;
  cursor: pointer;
}
.btn-record-stop:hover { background: #52525b; }

.recording-status {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  font-size: 13px;
  color: #dc2626;
}

.rec-dot {
  width: 8px;
  height: 8px;
  background: #dc2626;
  border-radius: 50%;
  animation: blink 1s infinite;
}

@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.2; }
}

.recorded-section { margin-top: 12px; }

.audio-preview { width: 100%; height: 36px; margin-bottom: 10px; }

.upload-form { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }

.name-input {
  flex: 1;
  min-width: 120px;
  padding: 6px 10px;
  background: #ffffff;
  border: 1px solid #e4e4e7;
  border-radius: 6px;
  color: #18181b;
  font-size: 13px;
  outline: none;
}
.name-input:focus { border-color: #4a9eff; }

.btn-upload {
  padding: 6px 14px;
  background: #4a9eff;
  border: none;
  border-radius: 6px;
  color: #fff;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}
.btn-upload:hover:not(:disabled) { background: #3a8ef0; }
.btn-upload:disabled { opacity: 0.5; cursor: not-allowed; }

.btn-discard {
  padding: 6px 12px;
  background: transparent;
  border: 1px solid #e4e4e7;
  border-radius: 6px;
  color: #71717a;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}
.btn-discard:hover { color: #18181b; border-color: #a1a1aa; }

.btn-file-import {
  padding: 6px 14px;
  background: transparent;
  border: 1px solid #d4d4d8;
  border-radius: 6px;
  color: #52525b;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}
.btn-file-import:hover { border-color: #4a9eff; color: #4a9eff; }

/* Footer */
.vs-footer {
  padding: 14px 20px;
  border-top: 1px solid #e4e4e7;
  display: flex;
  justify-content: flex-end;
  flex-shrink: 0;
}

.btn-confirm {
  padding: 8px 24px;
  background: #4a9eff;
  border: none;
  border-radius: 6px;
  color: #fff;
  font-size: 14px;
  cursor: pointer;
}
.btn-confirm:hover { background: #3a8ef0; }
</style>
