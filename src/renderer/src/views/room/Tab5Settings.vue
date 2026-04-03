<template>
  <div class="tab-settings">
    <div class="settings-form">
      <h2>系统设置</h2>

      <div class="section">
        <div class="section-title">AI 接口</div>
        <div class="field">
          <label>Dashscope API Key (Qwen)</label>
          <input v-model="settings.dashscope_api_key" type="password" placeholder="sk-..." />
        </div>
      </div>

      <div class="section">
        <div class="section-title">语音合成</div>
        <div class="field">
          <label>UCloud TTS API Key</label>
          <input v-model="settings.ucloud_tts_api_key" type="password" placeholder="API Key" />
        </div>
        <div class="field">
          <label>TTS Base URL</label>
          <input v-model="settings.ucloud_tts_base_url" placeholder="https://..." />
        </div>
        <div class="field">
          <label>TTS 模型</label>
          <input v-model="settings.ucloud_tts_model" placeholder="IndexTeam/IndexTTS-2" />
        </div>
      </div>

      <div class="section">
        <div class="section-title">数字人引擎</div>
        <div class="field">
          <label>口型后端</label>
          <input value="yundingyunbo v191" disabled />
          <span class="field-hint">当前程序已固定走 yundingyunbo v191，不再使用 DIANJT。</span>
        </div>
        <div class="field">
          <label>数据目录</label>
          <input v-model="settings.data_dir" placeholder="留空则自动使用程序同级的 heygem_data" />
        </div>
        <div class="field">
          <label>云顶云播目录</label>
          <input v-model="settings.yundingyunbo_base" placeholder="留空则自动查找程序同级的 yundingyunbo_v163" />
        </div>
      </div>

      <div class="section">
        <div class="section-title">在线升级</div>
        <div class="field">
          <label>更新清单 URL</label>
          <input
            v-model="settings.update_manifest_url"
            placeholder="https://your-oss-domain/xiyiji/stable/manifest.json"
          />
          <span class="field-hint">程序内检查更新、下载升级包都使用这个地址。</span>
        </div>
        <div class="field">
          <label>完整包百度网盘链接</label>
          <input v-model="settings.full_package_url" placeholder="https://pan.baidu.com/s/..." />
        </div>
        <div class="field">
          <label>完整包提取码</label>
          <input v-model="settings.full_package_code" placeholder="例如 1234" />
        </div>
      </div>

      <div class="save-row">
        <button class="btn-primary" :disabled="saving" @click="handleSave">
          {{ saving ? '保存中...' : '保存设置' }}
        </button>
        <span v-if="saved" class="saved-hint">已保存</span>
      </div>

      <div class="section">
        <div class="section-title">平台连接</div>
        <div class="platform-row">
          <div class="platform-info">
            <span class="platform-label">抖音</span>
            <span class="platform-status" :class="`ps-${platformStatus}`">
              {{ platformStatusLabel }}
            </span>
          </div>
          <div class="platform-actions">
            <button
              v-if="platformStatus !== 'connected'"
              class="btn-platform connect"
              :disabled="platformConnecting"
              @click="handlePlatformConnect"
            >
              {{ platformConnecting ? '连接中...' : '连接' }}
            </button>
            <button
              v-else
              class="btn-platform disconnect"
              @click="handlePlatformDisconnect"
            >
              断开
            </button>
          </div>
        </div>
      </div>

      <div class="section">
        <div class="section-title">授权信息</div>
        <div v-if="licenseInfo" class="license-row">
          <div class="field">
            <label>授权状态</label>
            <span class="license-status" :class="`ls-${licenseInfo.status}`">
              {{ licenseStatusLabel(licenseInfo.status) }}
            </span>
          </div>
          <div v-if="licenseInfo.expiresAt" class="field">
            <label>到期时间</label>
            <span class="license-date">{{ licenseInfo.expiresAt.slice(0, 10) }}</span>
          </div>
          <div v-if="licenseInfo.daysRemaining !== null" class="field">
            <label>剩余天数</label>
            <span>{{ licenseInfo.daysRemaining }} 天</span>
          </div>
        </div>
        <div class="field" style="margin-top: 12px">
          <label>激活码</label>
          <div style="display: flex; gap: 8px">
            <input v-model="activationCode" placeholder="输入激活码" style="flex: 1" />
            <button class="btn-primary" style="padding: 8px 14px; white-space: nowrap" @click="handleActivate">激活</button>
          </div>
        </div>
      </div>

      <div class="section">
        <div class="section-title">升级面板</div>
        <AppUpdatePanel />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import AppUpdatePanel from '../../components/system/AppUpdatePanel.vue'

defineProps<{ roomId: string }>()

const settings = ref<Record<string, string>>({
  dashscope_api_key: '',
  ucloud_tts_api_key: '',
  ucloud_tts_base_url: '',
  ucloud_tts_model: '',
  update_manifest_url: '',
  full_package_url: '',
  full_package_code: '',
  lipsync_backend: 'yundingyunbo',
  data_dir: '',
  yundingyunbo_base: ''
})
const saving = ref(false)
const saved = ref(false)

const platformStatus = ref<'connected' | 'disconnected' | 'error'>('disconnected')
const platformConnecting = ref(false)

const platformStatusLabel = computed(() => {
  const map: Record<string, string> = {
    connected: '已连接',
    disconnected: '未连接',
    error: '连接错误'
  }
  return map[platformStatus.value] || platformStatus.value
})

async function handlePlatformConnect(): Promise<void> {
  platformConnecting.value = true
  try {
    await window.api.platformConnect('douyin', {})
    const status = await window.api.platformStatus()
    platformStatus.value = status?.status || 'error'
  } finally {
    platformConnecting.value = false
  }
}

async function handlePlatformDisconnect(): Promise<void> {
  await window.api.platformDisconnect()
  platformStatus.value = 'disconnected'
}

const licenseInfo = ref<any>(null)
const activationCode = ref('')

function licenseStatusLabel(status: string): string {
  const map: Record<string, string> = {
    valid: '正常',
    warn: '即将到期',
    critical: '危险',
    expired: '已过期',
    none: '未激活'
  }
  return map[status] || status
}

async function handleActivate(): Promise<void> {
  if (!activationCode.value.trim()) return
  const result = await window.api.licenseActivate(activationCode.value.trim())
  if (result?.ok) {
    licenseInfo.value = result.info
    activationCode.value = ''
  } else {
    alert(result?.error || '激活失败')
  }
}

const KEYS = Object.keys(settings.value)

async function load(): Promise<void> {
  for (const key of KEYS) {
    const val = await window.api.settingsGet(key)
    if (val !== undefined && val !== null) settings.value[key] = String(val)
  }
  settings.value.lipsync_backend = 'yundingyunbo'

  const status = await window.api.platformStatus()
  platformStatus.value = status?.status || 'disconnected'
  licenseInfo.value = await window.api.licenseGetInfo()
}

async function handleSave(): Promise<void> {
  saving.value = true
  try {
    settings.value.lipsync_backend = 'yundingyunbo'
    for (const key of KEYS) {
      await window.api.settingsSet(key, settings.value[key])
    }
    await window.api.pipelineSetBackend('yundingyunbo')
    saved.value = true
    setTimeout(() => {
      saved.value = false
    }, 2000)
  } finally {
    saving.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.tab-settings {
  height: 100%;
  overflow-y: auto;
  padding: 24px;
  background: #f5f5f7;
}

.settings-form {
  max-width: 600px;
}

h2 {
  font-size: 18px;
  color: #18181b;
  margin-bottom: 24px;
}

.section {
  background: #ffffff;
  border: 1px solid #e4e4e7;
  border-radius: 8px;
  padding: 20px;
  margin-bottom: 20px;
}

.section-title {
  font-size: 13px;
  font-weight: 600;
  color: #71717a;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 16px;
}

.field {
  margin-bottom: 14px;
}

.field label {
  display: block;
  font-size: 12px;
  color: #71717a;
  margin-bottom: 6px;
}

.field input {
  width: 100%;
  padding: 8px 12px;
  background: #f9f9fb;
  border: 1px solid #e4e4e7;
  border-radius: 6px;
  color: #18181b;
  font-size: 14px;
  outline: none;
  transition: border-color 0.2s;
}

.field input:focus {
  border-color: #4a9eff;
}

.field input:disabled {
  color: #52525b;
  background: #f4f4f5;
}

.field-hint {
  display: block;
  font-size: 11px;
  color: #a1a1aa;
  margin-top: 4px;
}

.save-row {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-top: 24px;
}

.btn-primary {
  padding: 10px 24px;
  background: #4a9eff;
  border: none;
  border-radius: 6px;
  color: #fff;
  font-size: 14px;
  cursor: pointer;
}

.btn-primary:hover:not(:disabled) {
  background: #3a8ef0;
}

.btn-primary:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.saved-hint {
  font-size: 13px;
  color: #16a34a;
}

.platform-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 0;
}

.platform-info {
  display: flex;
  align-items: center;
  gap: 12px;
}

.platform-label {
  font-size: 14px;
  color: #18181b;
}

.platform-status {
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 10px;
}

.ps-connected {
  background: #dcfce7;
  color: #16a34a;
}

.ps-disconnected {
  background: #f4f4f5;
  color: #71717a;
}

.ps-error {
  background: #fee2e2;
  color: #dc2626;
}

.platform-actions {
  display: flex;
  gap: 8px;
}

.btn-platform {
  padding: 6px 14px;
  border: none;
  border-radius: 5px;
  font-size: 12px;
  cursor: pointer;
}

.btn-platform.connect {
  background: #4a9eff;
  color: #fff;
}

.btn-platform.connect:hover:not(:disabled) {
  background: #3a8ef0;
}

.btn-platform.connect:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn-platform.disconnect {
  background: #fff;
  color: #dc2626;
  border: 1px solid #dc2626;
}

.btn-platform.disconnect:hover {
  background: #fee2e2;
}

.license-row {
  display: flex;
  gap: 24px;
  flex-wrap: wrap;
}

.license-status {
  font-size: 13px;
  font-weight: 600;
}

.ls-valid {
  color: #16a34a;
}

.ls-warn {
  color: #ca8a04;
}

.ls-critical {
  color: #ea580c;
}

.ls-expired {
  color: #dc2626;
}

.ls-none {
  color: #71717a;
}

.license-date {
  font-size: 13px;
  color: #18181b;
}
</style>
