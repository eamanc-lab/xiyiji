<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useSettingsStore } from '@/stores/settings.store'

const settingsStore = useSettingsStore()
const isMaximized = ref(false)

async function checkMaximized() {
  isMaximized.value = await window.api.windowIsMaximized()
}

async function refreshStatus() {
  await settingsStore.fetchSystemInfo()
}

function minimize() {
  window.api.windowMinimize()
}

async function maximize() {
  await window.api.windowMaximize()
  await checkMaximized()
}

function close() {
  window.api.windowClose()
}

let statusInterval: ReturnType<typeof setInterval>

onMounted(() => {
  checkMaximized()
  void refreshStatus()
  statusInterval = setInterval(() => {
    void refreshStatus()
  }, 30000)
})

onUnmounted(() => clearInterval(statusInterval))
</script>

<template>
  <header class="app-header drag-region">
    <div class="header-left">
      <span class="app-title">云影数字人</span>
      <span class="app-subtitle">AI Digital Human</span>
    </div>

    <div class="header-center no-drag">
      <div class="engine-status">
        <span class="status-label">Engine:</span>
        <span class="engine-tag">yundingyunbo v191</span>
      </div>
      <div class="gpu-status" v-if="settingsStore.systemInfo?.gpu">
        <span class="status-label">GPU:</span>
        <span class="gpu-usage">{{ settingsStore.systemInfo.gpu.utilization }}%</span>
        <div class="gpu-bar">
          <div
            class="gpu-bar-fill"
            :style="{ width: settingsStore.systemInfo.gpu.utilization + '%' }"
          />
        </div>
      </div>
    </div>

    <div class="header-right no-drag">
      <button class="win-btn" @click="minimize" title="最小化">
        <svg viewBox="0 0 12 12"><rect x="1" y="5.5" width="10" height="1" fill="currentColor"/></svg>
      </button>
      <button class="win-btn" @click="maximize" :title="isMaximized ? '还原' : '最大化'">
        <svg v-if="!isMaximized" viewBox="0 0 12 12">
          <rect x="1.5" y="1.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1"/>
        </svg>
        <svg v-else viewBox="0 0 12 12">
          <rect x="2.5" y="0.5" width="8" height="8" fill="none" stroke="currentColor" stroke-width="1"/>
          <rect x="0.5" y="2.5" width="8" height="8" fill="var(--bg-primary)" stroke="currentColor" stroke-width="1"/>
        </svg>
      </button>
      <button class="win-btn win-close" @click="close" title="关闭">
        <svg viewBox="0 0 12 12">
          <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" stroke-width="1.2"/>
        </svg>
      </button>
    </div>
  </header>
</template>

<style scoped>
.app-header {
  height: var(--header-height);
  background: var(--bg-primary);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 8px 0 16px;
  border-bottom: 1px solid var(--border-color);
}

.header-left {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.app-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.app-subtitle {
  font-size: 11px;
  color: var(--text-muted);
}

.header-center {
  display: flex;
  align-items: center;
  gap: 20px;
}

.engine-status,
.gpu-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-secondary);
}

.status-label {
  color: var(--text-muted);
}

.engine-tag {
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(74, 158, 255, 0.12);
  color: #2b6ecf;
  font-weight: 600;
}

.gpu-usage {
  font-size: 11px;
  min-width: 28px;
}

.gpu-bar {
  width: 48px;
  height: 4px;
  background: var(--border-color);
  border-radius: 2px;
  overflow: hidden;
}

.gpu-bar-fill {
  height: 100%;
  background: var(--primary-color);
  transition: width 0.3s;
  border-radius: 2px;
}

.header-right {
  display: flex;
  align-items: center;
}

.win-btn {
  width: 36px;
  height: 28px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  transition: background 0.15s;
}

.win-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.win-btn svg {
  width: 12px;
  height: 12px;
}

.win-close:hover {
  background: var(--error-color);
  color: white;
}
</style>
