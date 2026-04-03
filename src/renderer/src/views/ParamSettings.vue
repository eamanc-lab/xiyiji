<script setup lang="ts">
import { ref, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '@/stores/settings.store'

const { t } = useI18n()
const settingsStore = useSettingsStore()
const saving = ref(false)
const saveMessage = ref('')

const chromaEnabled = ref(false)
const similarity = ref(52)
const smoothing = ref(1)
const bgEnabled = ref(false)
const bgImage = ref('default')
const bgImages = ref<string[]>([])

const vadThreshold = ref(0.60)
const minSilence = ref(500)
const speechPad = ref(30)
const energyThreshold = ref(0.04)

const backendAvailable = ref(false)
const checkingBackend = ref(false)

const dashscopeKey = ref('')
const ucloudKey = ref('')

onMounted(async () => {
  await settingsStore.fetchSettings()
  loadFromSettings()
  await Promise.all([
    checkBackendStatus(),
    settingsStore.fetchSystemInfo(),
    settingsStore.fetchDiskSpace()
  ])
})

function loadFromSettings() {
  chromaEnabled.value = settingsStore.getSetting('chroma_enabled', 'false') === 'true'
  similarity.value = parseInt(settingsStore.getSetting('chroma_similarity', '52'))
  smoothing.value = parseInt(settingsStore.getSetting('chroma_smoothing', '1'))
  bgEnabled.value = settingsStore.getSetting('bg_enabled', 'false') === 'true'
  bgImage.value = settingsStore.getSetting('bg_image', 'default')

  vadThreshold.value = parseFloat(settingsStore.getSetting('vad_threshold', '0.60'))
  minSilence.value = parseInt(settingsStore.getSetting('vad_min_silence', '500'))
  speechPad.value = parseInt(settingsStore.getSetting('vad_speech_pad', '30'))
  energyThreshold.value = parseFloat(settingsStore.getSetting('vad_energy_threshold', '0.04'))

  dashscopeKey.value = settingsStore.getSetting('dashscope_api_key', '')
  ucloudKey.value = settingsStore.getSetting('ucloud_tts_api_key', '')
}

async function checkBackendStatus() {
  checkingBackend.value = true
  try {
    const result = await window.api.pipelineCheckBackend('yundingyunbo')
    backendAvailable.value = result.available
  } catch {
    backendAvailable.value = false
  } finally {
    checkingBackend.value = false
  }
}

watch([chromaEnabled, similarity, smoothing], () => {
  window.api.playerSetChroma({
    enabled: chromaEnabled.value,
    similarity: similarity.value,
    smoothing: smoothing.value
  })
})

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '--'
  const gb = bytes / 1024 / 1024 / 1024
  return `${gb.toFixed(gb >= 100 ? 0 : 1)} GB`
}

async function saveSettings() {
  saving.value = true
  saveMessage.value = ''
  try {
    await settingsStore.updateSetting('chroma_enabled', String(chromaEnabled.value))
    await settingsStore.updateSetting('chroma_similarity', String(similarity.value))
    await settingsStore.updateSetting('chroma_smoothing', String(smoothing.value))
    await settingsStore.updateSetting('bg_enabled', String(bgEnabled.value))
    await settingsStore.updateSetting('bg_image', bgImage.value)

    await settingsStore.updateSetting('vad_threshold', String(vadThreshold.value))
    await settingsStore.updateSetting('vad_min_silence', String(minSilence.value))
    await settingsStore.updateSetting('vad_speech_pad', String(speechPad.value))
    await settingsStore.updateSetting('vad_energy_threshold', String(energyThreshold.value))

    await settingsStore.updateSetting('lipsync_backend', 'yundingyunbo')
    await window.api.pipelineSetBackend('yundingyunbo')

    await settingsStore.updateSetting('dashscope_api_key', dashscopeKey.value)
    await settingsStore.updateSetting('ucloud_tts_api_key', ucloudKey.value)

    await Promise.all([
      checkBackendStatus(),
      settingsStore.fetchSystemInfo(),
      settingsStore.fetchDiskSpace()
    ])

    saveMessage.value = '保存成功 Saved!'
    setTimeout(() => {
      saveMessage.value = ''
    }, 3000)
  } catch (err: any) {
    saveMessage.value = `保存失败: ${err.message}`
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="param-settings-page">
    <div class="page-header">
      <h2>{{ t('paramSettings.title') }}</h2>
    </div>
    <div class="page-body">
      <div class="settings-column">
        <div class="groupbox">
          <div class="groupbox-title">{{ t('paramSettings.background') }}</div>
          <div class="groupbox-content">
            <div class="setting-row">
              <label class="checkbox-label">
                <input type="checkbox" v-model="chromaEnabled" />
                {{ t('paramSettings.enableChroma') }}
              </label>
            </div>
            <div class="setting-row" v-if="chromaEnabled">
              <label>{{ t('paramSettings.similarity') }}</label>
              <input type="range" min="0" max="100" v-model.number="similarity" class="setting-range" />
              <span class="range-value">{{ similarity }}</span>
            </div>
            <div class="setting-row" v-if="chromaEnabled">
              <label>{{ t('paramSettings.smoothing') }}</label>
              <input type="range" min="0" max="10" v-model.number="smoothing" class="setting-range" />
              <span class="range-value">{{ smoothing }}</span>
            </div>
            <div class="setting-row">
              <label class="checkbox-label">
                <input type="checkbox" v-model="bgEnabled" />
                {{ t('paramSettings.enableBg') }}
              </label>
            </div>
            <div class="setting-row" v-if="bgEnabled">
              <label>{{ t('paramSettings.bgImage') }}</label>
              <select v-model="bgImage" class="setting-select">
                <option value="default">默认 Default</option>
                <option v-for="img in bgImages" :key="img" :value="img">{{ img }}</option>
              </select>
            </div>
          </div>
        </div>

        <div class="groupbox">
          <div class="groupbox-title">{{ t('paramSettings.vad') }}</div>
          <div class="groupbox-content">
            <div class="setting-row">
              <label>{{ t('paramSettings.vadThreshold') }}</label>
              <input type="range" min="0" max="1" step="0.01" v-model.number="vadThreshold" class="setting-range" />
              <span class="range-value">{{ vadThreshold.toFixed(2) }}</span>
            </div>
            <div class="setting-row">
              <label>{{ t('paramSettings.minSilence') }} (ms)</label>
              <input type="range" min="100" max="2000" step="50" v-model.number="minSilence" class="setting-range" />
              <span class="range-value">{{ minSilence }}</span>
            </div>
            <div class="setting-row">
              <label>{{ t('paramSettings.speechPad') }} (ms)</label>
              <input type="range" min="0" max="200" step="10" v-model.number="speechPad" class="setting-range" />
              <span class="range-value">{{ speechPad }}</span>
            </div>
            <div class="setting-row">
              <label>{{ t('paramSettings.energyThreshold') }}</label>
              <input type="range" min="0" max="0.2" step="0.005" v-model.number="energyThreshold" class="setting-range" />
              <span class="range-value">{{ energyThreshold.toFixed(3) }}</span>
            </div>
          </div>
        </div>
      </div>

      <div class="settings-column">
        <div class="groupbox">
          <div class="groupbox-title">{{ t('paramSettings.lipSyncEngine') }}</div>
          <div class="groupbox-content">
            <div class="setting-row">
              <label>{{ t('paramSettings.engineSelect') }}</label>
              <span>yundingyunbo v191</span>
            </div>
            <div class="setting-row">
              <label>{{ t('paramSettings.engineStatus') }}</label>
              <span v-if="checkingBackend" class="status-checking">{{ t('paramSettings.checking') }}</span>
              <span v-else :class="backendAvailable ? 'status-ok' : 'status-off'">
                {{ backendAvailable ? t('paramSettings.available') : t('paramSettings.unavailable') }}
              </span>
            </div>
            <div class="setting-row">
              <span class="hint-text">当前版本已固定走 yundingyunbo v191，本地运行不再依赖 DIANJT 或 Docker 容器。</span>
            </div>
          </div>
        </div>

        <div class="groupbox">
          <div class="groupbox-title">{{ t('paramSettings.apiKeys') }}</div>
          <div class="groupbox-content">
            <div class="setting-row vertical">
              <label>{{ t('paramSettings.dashscopeKey') }}</label>
              <input type="password" class="setting-input" v-model="dashscopeKey" placeholder="sk-..." />
            </div>
            <div class="setting-row vertical">
              <label>{{ t('paramSettings.ucloudKey') }}</label>
              <input type="password" class="setting-input" v-model="ucloudKey" placeholder="API Key..." />
            </div>
          </div>
        </div>

        <div class="groupbox">
          <div class="groupbox-title">系统状态</div>
          <div class="groupbox-content">
            <div class="setting-row" v-if="settingsStore.systemInfo?.gpu">
              <label>GPU</label>
              <span>{{ settingsStore.systemInfo.gpu.name }} ({{ settingsStore.systemInfo.gpu.utilization }}%)</span>
            </div>
            <div class="setting-row" v-if="settingsStore.diskSpace.total > 0">
              <label>数据盘可用空间</label>
              <span>{{ formatBytes(settingsStore.diskSpace.free) }} / {{ formatBytes(settingsStore.diskSpace.total) }}</span>
            </div>
            <div class="setting-row" v-if="!settingsStore.systemInfo?.gpu && settingsStore.diskSpace.total <= 0">
              <span class="hint-text">当前未读取到额外系统状态。</span>
            </div>
          </div>
        </div>

        <div class="save-section">
          <button class="save-btn" @click="saveSettings" :disabled="saving">
            {{ saving ? '保存中...' : t('paramSettings.save') }}
          </button>
          <span v-if="saveMessage" class="save-message" :class="saveMessage.includes('失败') ? 'error' : 'success'">
            {{ saveMessage }}
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.param-settings-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  gap: 12px;
}

.page-header h2 {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
}

.page-body {
  display: flex;
  flex: 1;
  gap: 16px;
  min-height: 0;
  overflow: auto;
}

.settings-column {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.groupbox {
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-card);
}

.groupbox-title {
  padding: 8px 12px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-secondary);
  border-radius: 6px 6px 0 0;
}

.groupbox-content {
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.setting-row {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 13px;
  color: var(--text-secondary);
}

.setting-row label {
  min-width: 160px;
  flex-shrink: 0;
}

.setting-row.vertical {
  flex-direction: column;
  align-items: stretch;
}

.setting-row.vertical label {
  min-width: unset;
  margin-bottom: 4px;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  min-width: unset !important;
}

.setting-range {
  flex: 1;
}

.range-value {
  min-width: 40px;
  text-align: right;
  font-size: 12px;
  color: var(--text-muted);
}

.setting-select {
  flex: 1;
  padding: 6px 8px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-size: 13px;
}

.setting-input {
  padding: 8px 12px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-size: 13px;
  outline: none;
}

.setting-input:focus {
  border-color: var(--primary-color);
}

.status-ok {
  color: var(--success-color);
}

.status-off {
  color: var(--text-muted);
}

.status-checking {
  color: var(--warning-color, #e6a23c);
  font-size: 13px;
}

.hint-text {
  font-size: 12px;
  color: var(--text-muted);
  font-style: italic;
}

.save-section {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: auto;
  padding-top: 12px;
}

.save-btn {
  padding: 10px 24px;
  border: none;
  border-radius: 6px;
  background: var(--primary-color);
  color: white;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.2s;
}

.save-btn:hover {
  opacity: 0.85;
}

.save-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.save-message {
  font-size: 13px;
}

.save-message.success {
  color: var(--success-color);
}

.save-message.error {
  color: var(--error-color);
}
</style>
