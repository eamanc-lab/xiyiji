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
        <div class="section-title">弹幕平台</div>
        <div class="field">
          <label>EulerStream API Key (TikTok)</label>
          <input v-model="settings.eulerstream_api_key" type="password" placeholder="euler_..." />
        </div>
      </div>

      <div class="section">
        <div class="section-title">授权服务</div>
        <div class="field">
          <label>服务器地址</label>
          <input v-model="settings.license_server_url" placeholder="https://your-server.com" />
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
          <span class="field-hint">程序内检查更新、下载升级包都走这里。</span>
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

      <div class="section">
        <div class="section-title">数字人引擎</div>
        <div class="field">
          <label>口型后端</label>
          <input value="yundingyunbo v191" disabled />
          <span class="field-hint">当前版本已固定使用 yundingyunbo v191，本地不再依赖 DIANJT。</span>
        </div>
        <div class="field">
          <label>数据目录</label>
          <input v-model="settings.data_dir" placeholder="留空则自动使用程序同级的 heygem_data" />
        </div>
        <div class="field">
          <label>云顶云播目录</label>
          <input v-model="settings.yundingyunbo_base" placeholder="留空则自动查找程序同级的 yundingyunbo_v163" />
          <span class="field-hint">建议保持在 D:\yunyin\yundingyunbo_v163。</span>
        </div>
      </div>

      <div class="save-row">
        <button class="btn-primary" :disabled="saving" @click="handleSave">
          {{ saving ? '保存中...' : '保存设置' }}
        </button>
        <span v-if="saved" class="saved-hint">已保存</span>
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
          <div v-if="licenseInfo.nickname" class="field">
            <label>昵称</label>
            <span>{{ licenseInfo.nickname }}</span>
          </div>
          <div v-if="licenseInfo.expiresAt" class="field">
            <label>到期时间</label>
            <span class="license-date">{{ licenseInfo.expiresAt.slice(0, 10) }}</span>
          </div>
          <div v-if="licenseInfo.daysRemaining !== null" class="field">
            <label>剩余天数</label>
            <span>{{ licenseInfo.daysRemaining }} 天</span>
          </div>
          <div v-if="licenseInfo.hoursTotal > 0" class="field">
            <label>剩余时长</label>
            <span :style="{ color: licenseInfo.hoursRemaining < 10 ? '#dc2626' : '#18181b' }">
              {{ licenseInfo.hoursRemaining?.toFixed(1) }}h / {{ licenseInfo.hoursTotal }}h
            </span>
          </div>
        </div>
      </div>

      <div class="section section-account">
        <div class="section-title">账号</div>
        <div class="account-row">
          <span class="account-name">{{ currentAccount || '未登录' }}</span>
          <button class="btn-logout" :disabled="loggingOut" @click="handleLogout">
            {{ loggingOut ? '退出中...' : '退出登录' }}
          </button>
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
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import AppUpdatePanel from '../../components/system/AppUpdatePanel.vue'

defineProps<{ roomId: string }>()

const router = useRouter()

const settings = ref<Record<string, string>>({
  dashscope_api_key: '',
  ucloud_tts_api_key: '',
  ucloud_tts_base_url: '',
  ucloud_tts_model: '',
  eulerstream_api_key: '',
  license_server_url: '',
  update_manifest_url: '',
  full_package_url: '',
  full_package_code: '',
  lipsync_backend: 'yundingyunbo',
  data_dir: '',
  yundingyunbo_base: ''
})
const saving = ref(false)
const saved = ref(false)
const licenseInfo = ref<any>(null)
const currentAccount = ref('')
const loggingOut = ref(false)

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

async function handleLogout(): Promise<void> {
  if (!window.confirm('确认退出登录？')) return
  loggingOut.value = true
  try {
    await window.api.licenseLogout()
    localStorage.removeItem('auth_token')
    localStorage.removeItem('auth_account')
    router.push('/login')
  } catch {
    alert('退出登录失败')
  } finally {
    loggingOut.value = false
  }
}

const KEYS = Object.keys(settings.value)

async function load(): Promise<void> {
  for (const key of KEYS) {
    const val = await window.api.settingsGet(key)
    if (val !== undefined && val !== null) settings.value[key] = String(val)
  }
  settings.value.lipsync_backend = 'yundingyunbo'

  try {
    const refreshResult = await window.api.licenseRefresh()
    if (refreshResult?.ok && refreshResult.info) {
      licenseInfo.value = refreshResult.info
    } else {
      licenseInfo.value = await window.api.licenseGetInfo()
    }
  } catch {
    licenseInfo.value = await window.api.licenseGetInfo()
  }

  currentAccount.value = localStorage.getItem('auth_account') || licenseInfo.value?.nickname || ''
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

.section-account {
  margin-top: 12px;
}

.account-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.account-name {
  font-size: 14px;
  color: #18181b;
}

.btn-logout {
  padding: 7px 20px;
  background: #fff;
  color: #dc2626;
  border: 1px solid #dc2626;
  border-radius: 6px;
  font-size: 13px;
  cursor: pointer;
  transition: background 0.15s;
}

.btn-logout:hover:not(:disabled) {
  background: #fee2e2;
}

.btn-logout:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
