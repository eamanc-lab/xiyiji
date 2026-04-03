<template>
  <div class="app-root">
    <!-- Global title bar: drag region + window controls always at top-right -->
    <div class="app-titlebar drag-region">
      <span class="titlebar-name">
        {{ appName }}
        <span v-if="appVersion" class="titlebar-version">{{ appVersion }}</span>
      </span>
      <win-bar class="no-drag" />
    </div>

    <!-- View content below the title bar -->
    <div class="app-body">
      <router-view v-slot="{ Component }">
        <transition name="fade" mode="out-in">
          <component :is="Component" />
        </transition>
      </router-view>
    </div>

    <div v-if="startupUpdatePromptVisible && startupUpdaterState" class="startup-update-overlay">
      <div class="startup-update-card">
        <div class="startup-update-title">{{ startupUpdatePromptTitle }}</div>
        <div class="startup-update-subtitle">
          当前版本 {{ startupUpdaterState.currentVersion || '-' }}
          <template v-if="startupUpdaterState.availableVersion">
            <span class="startup-update-divider">/</span>
            最新版本 {{ startupUpdaterState.availableVersion }}
          </template>
        </div>
        <div class="startup-update-message">{{ startupUpdatePromptMessage }}</div>
        <div v-if="showStartupUpdateProgress" class="startup-update-progress">
          <div
            class="startup-update-progress-fill"
            :style="{ width: `${Math.max(6, startupUpdaterState.progress || 0)}%` }"
          />
        </div>
        <div class="startup-update-actions">
          <button
            class="startup-update-btn startup-update-btn-secondary"
            :disabled="startupUpdateBusy"
            @click="dismissStartupUpdatePrompt"
          >
            稍后
          </button>
          <button
            class="startup-update-btn startup-update-btn-primary"
            :disabled="startupUpdateBusy || !startupUpdateCanAct"
            @click="handleStartupUpdatePrimary"
          >
            {{ startupUpdatePrimaryLabel }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watchEffect } from 'vue'
import packageJson from '../../../package.json'
import { formatDisplayVersion } from '../../shared/app-version'
import WinBar from './components/layout/WinBar.vue'

interface StartupUpdaterState {
  isPackaged?: boolean
  currentVersion: string
  phase: string
  progress: number
  message: string
  error: string
  availableVersion: string
}

const appName = '云映数字人'
const bundledAppVersion = formatDisplayVersion(String(packageJson.version || '').trim())
const appVersion = ref(bundledAppVersion)
const startupUpdaterState = ref<StartupUpdaterState | null>(null)
const startupUpdatePromptVisible = ref(false)
const startupUpdatePromptDismissed = ref(false)
const startupUpdateCheckStarted = ref(false)
const startupUpdateActionPending = ref(false)
let stopUpdaterStateSubscription: (() => void) | null = null

const documentTitle = computed(() =>
  appVersion.value ? `${appName} ${appVersion.value}` : appName
)

const startupUpdatePromptTitle = computed(() => {
  const phase = startupUpdaterState.value?.phase || ''
  return phase === 'downloaded' || phase === 'applying' ? '更新已准备就绪' : '发现新版本'
})

const startupUpdatePromptMessage = computed(() => {
  const state = startupUpdaterState.value
  if (!state) return ''

  if (state.phase === 'available') {
    return `检测到新版本 ${state.availableVersion || ''}，客户可以自行选择现在下载，或稍后再处理。`
  }
  if (state.phase === 'downloaded') {
    return state.message || '更新包已经准备完成，可以自行选择立即升级或稍后安装。'
  }
  if (state.phase === 'downloading' || state.phase === 'applying') {
    return state.message || '正在处理更新，请稍候。'
  }
  return state.message || ''
})

const showStartupUpdateProgress = computed(() => {
  const phase = startupUpdaterState.value?.phase || ''
  return phase === 'downloading' || phase === 'applying'
})

const startupUpdateBusy = computed(() => {
  const phase = startupUpdaterState.value?.phase || ''
  return (
    startupUpdateActionPending.value ||
    phase === 'checking' ||
    phase === 'downloading' ||
    phase === 'applying'
  )
})

const startupUpdateCanAct = computed(() => {
  const phase = startupUpdaterState.value?.phase || ''
  return phase === 'available' || phase === 'downloaded'
})

const startupUpdatePrimaryLabel = computed(() => {
  const phase = startupUpdaterState.value?.phase || ''
  if (phase === 'downloaded') return '立即升级'
  if (phase === 'downloading') return '下载中...'
  if (phase === 'applying') return '重启中...'
  return '立即下载'
})

watchEffect(() => {
  document.title = documentTitle.value
})

function syncStartupUpdatePrompt(nextState?: StartupUpdaterState | null): void {
  const state = nextState ?? startupUpdaterState.value
  if (!state?.isPackaged) {
    startupUpdatePromptVisible.value = false
    return
  }
  if (startupUpdatePromptDismissed.value) {
    return
  }
  startupUpdatePromptVisible.value =
    state.phase === 'available' ||
    state.phase === 'downloaded' ||
    state.phase === 'downloading' ||
    state.phase === 'applying'
}

async function refreshStartupUpdaterState(): Promise<void> {
  startupUpdaterState.value = await window.api.updaterGetState()
  syncStartupUpdatePrompt(startupUpdaterState.value)
}

async function runStartupUpdateCheck(): Promise<void> {
  if (startupUpdateCheckStarted.value) return
  const state = startupUpdaterState.value
  if (!state?.isPackaged) return
  if (state.phase === 'downloaded' || state.phase === 'applying') {
    syncStartupUpdatePrompt(state)
    return
  }

  startupUpdateCheckStarted.value = true
  try {
    startupUpdaterState.value = await window.api.updaterCheck()
    syncStartupUpdatePrompt(startupUpdaterState.value)
  } catch (err: any) {
    console.warn(`[App] Startup updater check failed: ${err?.message || err}`)
  }
}

function dismissStartupUpdatePrompt(): void {
  startupUpdatePromptDismissed.value = true
  startupUpdatePromptVisible.value = false
}

async function handleStartupUpdatePrimary(): Promise<void> {
  const state = startupUpdaterState.value
  if (!state) return

  startupUpdateActionPending.value = true
  try {
    if (state.phase === 'downloaded') {
      if (!window.confirm('程序将退出并自动安装升级，确认继续？')) {
        return
      }
      await window.api.updaterApply()
      return
    }

    startupUpdaterState.value = await window.api.updaterDownload()
    startupUpdatePromptDismissed.value = false
    syncStartupUpdatePrompt(startupUpdaterState.value)
  } catch (err: any) {
    console.warn(`[App] Startup update action failed: ${err?.message || err}`)
    try {
      await refreshStartupUpdaterState()
    } catch (refreshErr: any) {
      console.warn(
        `[App] Failed to refresh updater state after startup action: ${refreshErr?.message || refreshErr}`
      )
    }
  } finally {
    startupUpdateActionPending.value = false
  }
}

onMounted(async () => {
  stopUpdaterStateSubscription = window.api.onUpdaterState((nextState: StartupUpdaterState) => {
    startupUpdaterState.value = nextState
    syncStartupUpdatePrompt(nextState)
  })

  try {
    const info = await window.api.getAppInfo()
    const runtimeVersion = formatDisplayVersion(String(info?.version || '').trim())
    if (runtimeVersion) {
      appVersion.value = runtimeVersion
    } else if (bundledAppVersion) {
      console.warn('[App] app:info returned empty version, using bundled package version')
    }
  } catch (err: any) {
    if (bundledAppVersion) {
      console.warn(
        `[App] Failed to load runtime app version, using bundled package version: ${err?.message || err}`
      )
    } else {
      appVersion.value = ''
    }
  }

  try {
    await refreshStartupUpdaterState()
    await runStartupUpdateCheck()
  } catch (err: any) {
    console.warn(`[App] Failed to initialize startup updater prompt: ${err?.message || err}`)
  }
})

onBeforeUnmount(() => {
  stopUpdaterStateSubscription?.()
})
</script>

<style>
*,
*::before,
*::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

html,
body,
#app {
  width: 100%;
  height: 100%;
  overflow: hidden;
  font-family: 'PingFang SC', 'Microsoft YaHei', 'Helvetica Neue', Arial, sans-serif;
  font-size: 14px;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: #d4d4d8; border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: #a1a1aa; }

.fade-enter-active,
.fade-leave-active { transition: opacity 0.15s ease; }
.fade-enter-from,
.fade-leave-to { opacity: 0; }
</style>

<style scoped>
.app-root {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.app-titlebar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 36px;
  flex-shrink: 0;
  background: #ffffff;
  border-bottom: 1px solid #e4e4e7;
  padding-left: 14px;
}

.titlebar-name {
  font-size: 13px;
  font-weight: 600;
  color: #18181b;
  user-select: none;
}

.titlebar-version {
  margin-left: 6px;
  font-size: 12px;
  font-weight: 500;
  color: #71717a;
}

.app-body {
  flex: 1;
  overflow: hidden;
}

.startup-update-overlay {
  position: fixed;
  inset: 0;
  z-index: 2000;
  background: rgba(15, 23, 42, 0.18);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 72px 20px 20px;
}

.startup-update-card {
  width: min(440px, 100%);
  background: #ffffff;
  border: 1px solid #dbe2ea;
  border-radius: 16px;
  box-shadow: 0 18px 48px rgba(15, 23, 42, 0.18);
  padding: 18px 18px 16px;
}

.startup-update-title {
  font-size: 17px;
  font-weight: 700;
  color: #111827;
}

.startup-update-subtitle {
  margin-top: 6px;
  font-size: 12px;
  color: #6b7280;
}

.startup-update-divider {
  margin: 0 6px;
}

.startup-update-message {
  margin-top: 14px;
  font-size: 14px;
  line-height: 1.65;
  color: #1f2937;
}

.startup-update-progress {
  margin-top: 14px;
  height: 8px;
  border-radius: 999px;
  background: #e5e7eb;
  overflow: hidden;
}

.startup-update-progress-fill {
  height: 100%;
  background: linear-gradient(90deg, #2563eb, #0ea5e9);
  border-radius: 999px;
  transition: width 0.2s ease;
}

.startup-update-actions {
  margin-top: 16px;
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.startup-update-btn {
  min-width: 96px;
  height: 36px;
  border-radius: 10px;
  border: 1px solid transparent;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
}

.startup-update-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.startup-update-btn-secondary {
  background: #ffffff;
  border-color: #d1d5db;
  color: #374151;
}

.startup-update-btn-secondary:hover:not(:disabled) {
  background: #f9fafb;
}

.startup-update-btn-primary {
  background: #2563eb;
  color: #ffffff;
}

.startup-update-btn-primary:hover:not(:disabled) {
  background: #1d4ed8;
}
</style>
