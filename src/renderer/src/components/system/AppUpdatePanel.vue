<template>
  <div class="update-panel" :class="{ compact }">
    <div class="panel-header">
      <div>
        <div class="panel-title">在线升级</div>
        <div class="panel-subtitle">
          当前版本 {{ state.currentVersion || '-' }}
          <template v-if="state.availableVersion">
            <span class="divider">/</span>
            最新版本 {{ state.availableVersion }}
          </template>
        </div>
      </div>
      <span class="phase-badge" :class="phaseClass">{{ phaseLabel }}</span>
    </div>

    <div
      v-if="state.lastResult"
      class="result-box"
      :class="state.lastResult.status === 'success' ? 'result-success' : 'result-error'"
    >
      <span>
        {{
          state.lastResult.status === 'success'
            ? `上次升级已完成：${state.lastResult.version}`
            : `上次升级失败并已自动回滚：${state.lastResult.message}`
        }}
      </span>
      <button class="inline-link" @click="clearResult">知道了</button>
    </div>

    <div v-if="state.manifest?.notes" class="notes-box">
      {{ state.manifest.notes }}
    </div>

    <div v-if="displayError" class="error-box">
      {{ displayError }}
    </div>

    <div class="status-text">
      {{ statusText }}
    </div>

    <div v-if="showProgress" class="progress-track">
      <div class="progress-fill" :style="{ width: `${Math.max(4, state.progress || 0)}%` }" />
    </div>

    <div class="actions">
      <button class="btn secondary" :disabled="busy" @click="handleCheck">
        {{ checking ? '检查中...' : '检查更新' }}
      </button>
      <button class="btn primary" :disabled="!canDownload" @click="handleDownload">
        {{ downloading ? '下载中...' : '下载升级包' }}
      </button>
      <button class="btn primary" :disabled="!canApply" @click="handleApply">
        {{ applying ? '重启中...' : '立即重启升级' }}
      </button>
      <button class="btn secondary" :disabled="!hasFullPackage || openingFull" @click="handleOpenFullPackage">
        {{ openingFull ? '打开中...' : '完整包下载' }}
      </button>
    </div>

    <div v-if="hasFullPackage" class="full-package-hint">
      完整包来源：百度网盘
      <template v-if="state.configuredFullPackageCode">
        ，提取码 {{ state.configuredFullPackageCode }}
      </template>
    </div>

    <div class="panel-footnote">
      在线升级只替换程序层，不覆盖 `data`、`heygem_data`、`logs`、`xiyiji_output` 和 `yundingyunbo_v163`。
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

interface UpdateResultRecord {
  status: 'success' | 'rollback'
  version: string
  timestamp: string
  message: string
  logFile?: string
}

interface UpdateManifestView {
  version: string
  notes?: string
  fullPackage?: {
    url?: string
    code?: string
    note?: string
  }
}

interface UpdaterStateView {
  currentVersion: string
  phase: string
  progress: number
  message: string
  error: string
  availableVersion: string
  configuredFullPackageUrl: string
  configuredFullPackageCode: string
  manifest: UpdateManifestView | null
  lastResult: UpdateResultRecord | null
}

const props = withDefaults(
  defineProps<{
    compact?: boolean
  }>(),
  {
    compact: false
  }
)

const state = ref<UpdaterStateView>({
  currentVersion: '',
  phase: 'idle',
  progress: 0,
  message: '',
  error: '',
  availableVersion: '',
  configuredFullPackageUrl: '',
  configuredFullPackageCode: '',
  manifest: null,
  lastResult: null
})
const checking = ref(false)
const downloading = ref(false)
const applying = ref(false)
const openingFull = ref(false)
const localError = ref('')

let unsubscribe: (() => void) | null = null

const busy = computed(
  () => checking.value || downloading.value || applying.value || openingFull.value
)

const hasFullPackage = computed(
  () =>
    Boolean(state.value.manifest?.fullPackage?.url) ||
    Boolean(state.value.configuredFullPackageUrl)
)

const canDownload = computed(() => {
  if (busy.value) return false
  return state.value.phase === 'available' || state.value.phase === 'error'
})

const canApply = computed(() => {
  if (busy.value) return false
  return state.value.phase === 'downloaded'
})

const showProgress = computed(
  () => state.value.phase === 'downloading' || state.value.phase === 'applying'
)

const displayError = computed(() => localError.value || state.value.error || '')

const statusText = computed(() => {
  if (state.value.message) return state.value.message
  if (!state.value.currentVersion) return '正在读取升级状态...'
  return '可手动检查更新，也可直接打开完整包'
})

const phaseLabel = computed(() => {
  const map: Record<string, string> = {
    idle: '待命',
    checking: '检查中',
    available: '可升级',
    downloading: '下载中',
    downloaded: '待安装',
    applying: '安装中',
    error: '异常'
  }
  return map[state.value.phase] || state.value.phase || '待命'
})

const phaseClass = computed(() => {
  const map: Record<string, string> = {
    idle: 'phase-idle',
    checking: 'phase-checking',
    available: 'phase-available',
    downloading: 'phase-downloading',
    downloaded: 'phase-downloaded',
    applying: 'phase-applying',
    error: 'phase-error'
  }
  return map[state.value.phase] || 'phase-idle'
})

async function refreshState(): Promise<void> {
  localError.value = ''
  state.value = await window.api.updaterGetState()
}

async function handleCheck(): Promise<void> {
  checking.value = true
  localError.value = ''
  try {
    state.value = await window.api.updaterCheck()
  } catch (error: any) {
    localError.value = error?.message || '检查更新失败'
  } finally {
    checking.value = false
  }
}

async function handleDownload(): Promise<void> {
  downloading.value = true
  localError.value = ''
  try {
    state.value = await window.api.updaterDownload()
  } catch (error: any) {
    localError.value = error?.message || '下载升级包失败'
  } finally {
    downloading.value = false
  }
}

async function handleApply(): Promise<void> {
  if (!window.confirm('程序将退出并自动安装升级，确认继续？')) {
    return
  }
  applying.value = true
  localError.value = ''
  try {
    await window.api.updaterApply()
  } catch (error: any) {
    applying.value = false
    localError.value = error?.message || '启动升级失败'
  }
}

async function handleOpenFullPackage(): Promise<void> {
  openingFull.value = true
  localError.value = ''
  try {
    const result = await window.api.updaterOpenFullPackage()
    if (result?.code) {
      window.alert(`已打开完整包下载链接。\n百度网盘提取码：${result.code}`)
    }
  } catch (error: any) {
    localError.value = error?.message || '打开完整包失败'
  } finally {
    openingFull.value = false
  }
}

async function clearResult(): Promise<void> {
  state.value = await window.api.updaterClearResult()
}

onMounted(async () => {
  await refreshState()
  unsubscribe = window.api.onUpdaterState((nextState: UpdaterStateView) => {
    state.value = nextState
  })
})

onBeforeUnmount(() => {
  unsubscribe?.()
})
</script>

<style scoped>
.update-panel {
  background: #ffffff;
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.update-panel.compact {
  padding: 14px;
}

.panel-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.panel-title {
  font-size: 15px;
  font-weight: 700;
  color: #111827;
}

.panel-subtitle {
  font-size: 12px;
  color: #6b7280;
  margin-top: 4px;
}

.divider {
  margin: 0 6px;
}

.phase-badge {
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}

.phase-idle {
  background: #f3f4f6;
  color: #4b5563;
}

.phase-checking,
.phase-downloading,
.phase-applying {
  background: #dbeafe;
  color: #1d4ed8;
}

.phase-available,
.phase-downloaded {
  background: #dcfce7;
  color: #166534;
}

.phase-error {
  background: #fee2e2;
  color: #b91c1c;
}

.result-box,
.notes-box,
.error-box {
  border-radius: 10px;
  padding: 10px 12px;
  font-size: 12px;
  line-height: 1.5;
}

.result-box {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.result-success {
  background: #ecfdf5;
  color: #166534;
  border: 1px solid #bbf7d0;
}

.result-error,
.error-box {
  background: #fef2f2;
  color: #b91c1c;
  border: 1px solid #fecaca;
}

.notes-box {
  background: #eff6ff;
  color: #1e3a8a;
  border: 1px solid #bfdbfe;
  white-space: pre-wrap;
}

.status-text {
  font-size: 13px;
  color: #374151;
}

.progress-track {
  width: 100%;
  height: 8px;
  background: #e5e7eb;
  border-radius: 999px;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, #2563eb, #10b981);
  border-radius: 999px;
  transition: width 0.2s ease;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.btn {
  border: none;
  border-radius: 8px;
  padding: 9px 14px;
  font-size: 13px;
  cursor: pointer;
  transition: opacity 0.15s ease, transform 0.15s ease;
}

.btn:hover:not(:disabled) {
  transform: translateY(-1px);
}

.btn:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.btn.primary {
  background: #2563eb;
  color: #ffffff;
}

.btn.secondary {
  background: #f3f4f6;
  color: #111827;
}

.full-package-hint,
.panel-footnote {
  font-size: 12px;
  color: #6b7280;
  line-height: 1.5;
}

.inline-link {
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 12px;
  text-decoration: underline;
}
</style>
