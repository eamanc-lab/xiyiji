<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useLiveStore, type AudioMode } from '@/stores/live.store'

const { t } = useI18n()
const liveStore = useLiveStore()

const micDevices = ref<MediaDeviceInfo[]>([])
const ttsVoices = ref<{ id: string; name: string }[]>([])
const submitting = ref(false)
const errorMsg = ref<string | null>(null)

// Mic real-time recording state
const recording = ref(false)
const recordingTime = ref(0)
const chunksSent = ref(0)
const CHUNK_SECONDS = 5

let micStream: MediaStream | null = null
let mediaRecorder: MediaRecorder | null = null
let audioChunks: Blob[] = []
let recordingTimer: ReturnType<typeof setInterval> | null = null
let chunkTimer: ReturnType<typeof setInterval> | null = null
let stopping = false // flag to prevent restart after final stop

onMounted(async () => {
  await enumerateMicDevices()
  await loadTtsVoices()
})

onUnmounted(() => {
  stopRecording()
})

async function enumerateMicDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    micDevices.value = devices.filter(d => d.kind === 'audioinput')
    if (micDevices.value.length > 0 && !liveStore.selectedMicId) {
      liveStore.selectedMicId = micDevices.value[0].deviceId
    }
  } catch {
    micDevices.value = []
  }
}

async function loadTtsVoices() {
  try {
    const result = await window.api.ttsVoices()
    if (result.voices) {
      ttsVoices.value = result.voices
    }
  } catch {
    ttsVoices.value = [
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
  }
}

async function selectAudioFile() {
  const result = await window.api.selectAudioFile()
  if (result.path) {
    liveStore.audioFilePath = result.path
  }
}

// --- WAV encoding ---

function encodeWav(audioBuffer: AudioBuffer): ArrayBuffer {
  const numChannels = 1
  const sampleRate = audioBuffer.sampleRate
  const bitsPerSample = 16
  const channelData = audioBuffer.getChannelData(0)
  const numSamples = channelData.length
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8)
  const blockAlign = numChannels * (bitsPerSample / 8)
  const dataSize = numSamples * blockAlign
  const headerSize = 44
  const buffer = new ArrayBuffer(headerSize + dataSize)
  const view = new DataView(buffer)

  writeString(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeString(view, 8, 'WAVE')
  writeString(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitsPerSample, true)
  writeString(view, 36, 'data')
  view.setUint32(40, dataSize, true)

  let offset = 44
  for (let i = 0; i < numSamples; i++) {
    let sample = channelData[i]
    sample = Math.max(-1, Math.min(1, sample))
    const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF
    view.setInt16(offset, intSample, true)
    offset += 2
  }

  return buffer
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i))
  }
}

/**
 * Convert webm blob chunks to WAV and submit to pipeline.
 */
async function submitChunks(chunks: Blob[]) {
  if (chunks.length === 0) return
  try {
    const webmBlob = new Blob(chunks, { type: 'audio/webm' })
    const webmBuffer = await webmBlob.arrayBuffer()
    const audioCtx = new AudioContext()
    const decodedAudio = await audioCtx.decodeAudioData(webmBuffer)
    const wavBuffer = encodeWav(decodedAudio)
    audioCtx.close()

    const result = await window.api.pipelineSubmitMic(wavBuffer)
    if (result.success) {
      chunksSent.value++
    } else {
      console.error('Mic chunk submit failed:', result.error)
    }
  } catch (err: any) {
    console.error('Mic chunk conversion/submit error:', err.message)
  }
}

// --- Real-time mic recording ---

async function startRecording() {
  if (!liveStore.videoRunning) {
    errorMsg.value = '请先启动视频'
    return
  }
  errorMsg.value = null
  stopping = false

  try {
    const constraints: MediaStreamConstraints = {
      audio: liveStore.selectedMicId
        ? { deviceId: { exact: liveStore.selectedMicId } }
        : true
    }
    micStream = await navigator.mediaDevices.getUserMedia(constraints)

    recording.value = true
    recordingTime.value = 0
    chunksSent.value = 0

    // Start time counter
    recordingTimer = setInterval(() => {
      recordingTime.value++
    }, 1000)

    // Start first recorder segment
    startNewRecorderSegment()

    // Auto-cycle every CHUNK_SECONDS
    chunkTimer = setInterval(() => {
      cycleRecorder()
    }, CHUNK_SECONDS * 1000)
  } catch (err: any) {
    errorMsg.value = `麦克风访问失败: ${err.message}`
  }
}

/**
 * Start a new MediaRecorder segment on the existing mic stream.
 */
function startNewRecorderSegment() {
  if (!micStream || stopping) return

  audioChunks = []
  mediaRecorder = new MediaRecorder(micStream, { mimeType: 'audio/webm;codecs=opus' })

  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) {
      audioChunks.push(e.data)
    }
  }

  mediaRecorder.onstop = () => {
    // Collect the chunks from this segment
    const chunks = [...audioChunks]
    audioChunks = []
    // Submit in background (don't await)
    submitChunks(chunks)

    // Start next segment if still recording
    if (recording.value && !stopping) {
      startNewRecorderSegment()
    }
  }

  mediaRecorder.start(200)
}

/**
 * Cycle: stop current recorder (triggers onstop → submit + restart).
 */
function cycleRecorder() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop()
  }
}

function stopRecording() {
  stopping = true

  // Stop chunk cycling
  if (chunkTimer) {
    clearInterval(chunkTimer)
    chunkTimer = null
  }

  // Stop time counter
  if (recordingTimer) {
    clearInterval(recordingTimer)
    recordingTimer = null
  }

  // Stop current recorder (will submit last chunk via onstop)
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop()
  }
  mediaRecorder = null

  // Release mic stream
  if (micStream) {
    micStream.getTracks().forEach(t => t.stop())
    micStream = null
  }

  recording.value = false
}

function formatRecordingTime(seconds: number): string {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0')
  const s = (seconds % 60).toString().padStart(2, '0')
  return `${m}:${s}`
}

// --- TTS ---

async function submitTtsToPipeline() {
  if (!liveStore.ttsText.trim() || submitting.value) return
  if (!liveStore.videoRunning) {
    errorMsg.value = '请先启动视频'
    return
  }
  errorMsg.value = null
  submitting.value = true
  try {
    const result = await window.api.pipelineSubmitTts(
      liveStore.ttsText,
      liveStore.ttsVoice,
      liveStore.ttsSpeed
    )
    if (!result.success) {
      errorMsg.value = result.error || 'TTS 合成失败'
    }
  } catch (err: any) {
    errorMsg.value = err.message || 'TTS 合成失败'
  } finally {
    submitting.value = false
  }
}

// --- File ---

async function submitFileToPipeline() {
  if (!liveStore.audioFilePath || submitting.value) return
  if (!liveStore.videoRunning) {
    errorMsg.value = '请先启动视频'
    return
  }
  errorMsg.value = null
  submitting.value = true
  try {
    const result = await window.api.pipelineSubmitAudio(
      liveStore.audioFilePath,
      'file'
    )
    if (!result.success) {
      errorMsg.value = result.error || '提交失败'
    }
  } catch (err: any) {
    errorMsg.value = err.message || '提交失败'
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="audio-input-panel">
    <div class="groupbox">
      <div class="groupbox-title">{{ t('digitalLive.audioInput') }}</div>
      <div class="groupbox-content">
        <!-- Mode selector -->
        <div class="mode-selector">
          <label class="radio-label" :class="{ active: liveStore.audioMode === 'mic' }">
            <input type="radio" name="audioMode" value="mic"
              :checked="liveStore.audioMode === 'mic'"
              @change="liveStore.setAudioMode('mic')" />
            {{ t('digitalLive.mic') }}
          </label>
          <label class="radio-label" :class="{ active: liveStore.audioMode === 'file' }">
            <input type="radio" name="audioMode" value="file"
              :checked="liveStore.audioMode === 'file'"
              @change="liveStore.setAudioMode('file')" />
            {{ t('digitalLive.audioFile') }}
          </label>
          <label class="radio-label" :class="{ active: liveStore.audioMode === 'tts' }">
            <input type="radio" name="audioMode" value="tts"
              :checked="liveStore.audioMode === 'tts'"
              @change="liveStore.setAudioMode('tts')" />
            {{ t('digitalLive.tts') }}
          </label>
        </div>

        <!-- Error message -->
        <div class="error-banner" v-if="errorMsg">
          {{ errorMsg }}
          <button class="dismiss-btn" @click="errorMsg = null">x</button>
        </div>

        <!-- Microphone mode (real-time) -->
        <div class="mode-content" v-if="liveStore.audioMode === 'mic'">
          <div class="form-row">
            <label>{{ t('digitalLive.micDevice') }}</label>
            <select v-model="liveStore.selectedMicId" class="form-select" :disabled="recording">
              <option v-for="device in micDevices" :key="device.deviceId" :value="device.deviceId">
                {{ device.label || `Mic ${micDevices.indexOf(device) + 1}` }}
              </option>
            </select>
          </div>

          <div class="mic-controls">
            <button
              v-if="!recording"
              class="form-btn btn-record"
              @click="startRecording"
              :disabled="submitting || !liveStore.videoRunning"
            >
              开始实时录音
            </button>
            <button
              v-else
              class="form-btn btn-stop-record"
              @click="stopRecording"
            >
              停止录音
            </button>
            <div class="recording-indicator" v-if="recording">
              <span class="rec-dot"></span>
              <span class="rec-time">{{ formatRecordingTime(recordingTime) }}</span>
              <span class="rec-chunks">已发送 {{ chunksSent }} 段</span>
            </div>
          </div>

          <div class="mic-hint">
            每{{ CHUNK_SECONDS }}秒自动采集并提交给数字人对口型
          </div>
          <div class="mic-hint" v-if="!liveStore.videoRunning" style="color: var(--warning-color);">
            请先启动视频
          </div>
        </div>

        <!-- Audio file mode -->
        <div class="mode-content" v-if="liveStore.audioMode === 'file'">
          <div class="form-row">
            <button class="form-btn" @click="selectAudioFile">
              {{ t('digitalLive.selectAudioFile') }}
            </button>
          </div>
          <div class="file-path" v-if="liveStore.audioFilePath">
            {{ liveStore.audioFilePath.split(/[/\\]/).pop() }}
          </div>
          <div class="form-row" v-if="liveStore.audioFilePath">
            <button
              class="form-btn btn-primary"
              @click="submitFileToPipeline"
              :disabled="submitting || !liveStore.videoRunning"
            >
              {{ submitting ? '提交中...' : '发送到数字人' }}
            </button>
            <span v-if="!liveStore.videoRunning" class="hint-text">请先启动视频</span>
          </div>
        </div>

        <!-- TTS mode -->
        <div class="mode-content" v-if="liveStore.audioMode === 'tts'">
          <div class="form-row">
            <label>{{ t('digitalLive.ttsVoice') }}</label>
            <select v-model="liveStore.ttsVoice" class="form-select">
              <option v-for="voice in ttsVoices" :key="voice.id" :value="voice.id">
                {{ voice.name }}
              </option>
            </select>
          </div>
          <div class="form-row">
            <label>{{ t('digitalLive.ttsSpeed') }}</label>
            <input type="range" min="0.5" max="2.0" step="0.1" v-model.number="liveStore.ttsSpeed" class="form-range" />
            <span class="range-val">{{ liveStore.ttsSpeed.toFixed(1) }}</span>
          </div>
          <div class="form-row vertical">
            <label>{{ t('digitalLive.ttsText') }}</label>
            <textarea v-model="liveStore.ttsText" class="form-textarea" rows="4"
              placeholder="输入要合成的文本..."></textarea>
          </div>
          <div class="form-row">
            <button
              class="form-btn btn-primary"
              @click="submitTtsToPipeline"
              :disabled="submitting || !liveStore.ttsText.trim() || !liveStore.videoRunning"
            >
              {{ submitting ? '提交中...' : '合成并驱动' }}
            </button>
            <span v-if="!liveStore.videoRunning" class="hint-text">请先启动视频</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mode-selector {
  display: flex;
  gap: 12px;
  margin-bottom: 12px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--border-light);
}

.radio-label {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 4px;
}

.radio-label.active {
  color: var(--primary-color);
  font-weight: 500;
}

.radio-label input[type="radio"] {
  accent-color: var(--primary-color);
}

.mode-content {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.form-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-secondary);
}

.form-row.vertical {
  flex-direction: column;
  align-items: stretch;
}

.form-row label {
  min-width: 70px;
  flex-shrink: 0;
}

.form-select {
  flex: 1;
  padding: 6px 8px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-size: 13px;
}

.form-range {
  flex: 1;
}

.range-val {
  min-width: 30px;
  text-align: right;
  font-size: 12px;
  color: var(--text-muted);
}

.form-btn {
  padding: 6px 14px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background: var(--bg-card);
  color: var(--text-primary);
  font-size: 13px;
  cursor: pointer;
}

.form-btn:hover {
  border-color: var(--primary-color);
}

.form-btn.btn-primary {
  background: var(--primary-color);
  color: white;
  border-color: var(--primary-color);
}

.form-btn.btn-record {
  background: #2BA471;
  color: white;
  border-color: #2BA471;
  width: 100%;
}

.form-btn.btn-stop-record {
  background: #D54941;
  color: white;
  border-color: #D54941;
  width: 100%;
  animation: pulse-red 1.5s infinite;
}

@keyframes pulse-red {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.8; }
}

.form-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.form-textarea {
  width: 100%;
  padding: 8px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-size: 13px;
  resize: vertical;
  font-family: inherit;
}

.form-textarea:focus {
  border-color: var(--primary-color);
  outline: none;
}

.file-path {
  font-size: 12px;
  color: var(--text-muted);
  padding: 4px 8px;
  background: var(--bg-secondary);
  border-radius: 4px;
}

.hint-text {
  font-size: 11px;
  color: var(--warning-color);
}

.error-banner {
  background: rgba(213, 73, 65, 0.1);
  color: #D54941;
  font-size: 12px;
  padding: 6px 10px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
}

.dismiss-btn {
  background: none;
  border: none;
  color: #D54941;
  cursor: pointer;
  font-size: 14px;
  padding: 0 4px;
}

/* Mic recording */
.mic-controls {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.recording-indicator {
  display: flex;
  align-items: center;
  gap: 8px;
  justify-content: center;
}

.rec-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #D54941;
  animation: blink-rec 1s infinite;
}

@keyframes blink-rec {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.2; }
}

.rec-time {
  font-size: 14px;
  font-weight: 600;
  font-family: monospace;
  color: #D54941;
}

.rec-chunks {
  font-size: 12px;
  color: var(--text-muted);
}

.mic-hint {
  font-size: 12px;
  color: var(--text-muted);
  text-align: center;
}
</style>
