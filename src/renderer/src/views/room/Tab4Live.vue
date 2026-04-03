<template>
  <div class="tab-live">
    <div class="live-controls">
      <div class="control-status">
        <span class="status-dot" :class="`dot-${liveStore.status}`" />
        <span class="status-text">{{ statusText }}</span>
        <span v-if="liveStore.status !== 'idle'" class="elapsed-badge">
          {{ elapsedDisplay }}
        </span>
        <span v-if="licenseInfo && licenseInfo.hoursTotal > 0 && liveStore.status !== 'idle'" class="hours-badge" :class="{ low: hoursLow }">
          {{ licenseInfo.hoursRemaining?.toFixed(1) }}h
        </span>
      </div>

      <div class="control-buttons">
        <button
          v-if="liveStore.status === 'idle'"
          class="btn-start"
          :disabled="actionLoading"
          @click="handleStart"
        >
          开始直播
        </button>

        <template v-else>
          <button
            v-if="liveStore.status === 'running'"
            class="btn-pause"
            :disabled="actionLoading"
            @click="liveStore.pause()"
          >
            暂停
          </button>
          <button
            v-else
            class="btn-resume"
            :disabled="actionLoading"
            @click="liveStore.resume()"
          >
            恢复
          </button>

          <button
            class="btn-stop"
            :disabled="actionLoading"
            @click="handleStop"
          >
            停止直播
          </button>
        </template>
      </div>

      <div class="manual-input" v-if="liveStore.status !== 'idle'">
        <input
          v-model="manualText"
          placeholder="手动输入话术，回车发送"
          @keyup.enter="handleManual"
        />
        <button @click="handleManual">发送</button>
      </div>
    </div>

    <div class="live-main" v-if="liveStore.status !== 'idle'">
      <div class="live-left">
        <LinkSwitcher :room-id="roomId" />
        <ShortcutBar :room-id="roomId" />
      </div>

      <div class="live-center">
        <QueuePanel />
      </div>

      <div class="live-right">
        <DanmakuPanel />
      </div>
    </div>

    <div v-else class="live-idle-placeholder">
      <p>点击"开始直播"启动 AI 话术引擎</p>
      <div v-if="licenseInfo && licenseInfo.status !== 'none'" class="license-summary">
        <span v-if="licenseInfo.expiresAt">到期: {{ licenseInfo.expiresAt.slice(0, 10) }}</span>
        <span v-if="licenseInfo.daysRemaining !== null">剩余: {{ licenseInfo.daysRemaining }} 天</span>
        <span v-if="licenseInfo.hoursTotal > 0" :class="{ 'hours-low': hoursLow }">
          剩余时长: {{ licenseInfo.hoursRemaining?.toFixed(1) }}h / {{ licenseInfo.hoursTotal }}h
        </span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useLiveStore } from '../../stores/live.store'
import QueuePanel from '../../components/live/QueuePanel.vue'
import DanmakuPanel from '../../components/live/DanmakuPanel.vue'
import LinkSwitcher from '../../components/live/LinkSwitcher.vue'
import ShortcutBar from '../../components/live/ShortcutBar.vue'

const props = defineProps<{
  roomId: string
  room: any
}>()

const liveStore = useLiveStore()
const actionLoading = ref(false)
const manualText = ref('')
const licenseInfo = ref<any>(null)
let cleanupShouldStop: (() => void) | null = null
let cleanupStatusUpdate: (() => void) | null = null

// ── Live session elapsed timer ──────────────────────────────────────────
const sessionStartTime = ref(0)
const elapsedSeconds = ref(0)
let elapsedTimer: ReturnType<typeof setInterval> | null = null

const elapsedDisplay = computed(() => {
  const s = elapsedSeconds.value
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
})

function startElapsedTimer(startTime: number): void {
  stopElapsedTimer()
  sessionStartTime.value = startTime
  elapsedSeconds.value = Math.floor((Date.now() - startTime) / 1000)
  elapsedTimer = setInterval(() => {
    elapsedSeconds.value = Math.floor((Date.now() - sessionStartTime.value) / 1000)
  }, 1000)
}

function stopElapsedTimer(): void {
  if (elapsedTimer) {
    clearInterval(elapsedTimer)
    elapsedTimer = null
  }
  elapsedSeconds.value = 0
  sessionStartTime.value = 0
}

// Start/stop timer when live status changes
watch(() => liveStore.status, async (newStatus) => {
  if (newStatus === 'running' || newStatus === 'paused') {
    if (!sessionStartTime.value) {
      // Try to get the server-side session start time (for page re-entry during live)
      const serverStart = await window.api.licenseSessionStartTime?.()
      const startTime = (serverStart && serverStart > 0) ? serverStart : Date.now()
      startElapsedTimer(startTime)
    }
  } else {
    stopElapsedTimer()
  }
}, { immediate: true })

onMounted(async () => {
  // Sync with remote server for accurate license data
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

  // If already streaming (page re-entry), start elapsed timer
  if (liveStore.status === 'running' || liveStore.status === 'paused') {
    const serverStart = await window.api.licenseSessionStartTime?.()
    const startTime = (serverStart && serverStart > 0) ? serverStart : Date.now()
    startElapsedTimer(startTime)
  }

  cleanupShouldStop = window.api.onLicenseShouldStop?.((data) => {
    alert(data.reason || '直播时长已用完，直播已自动停止')
    liveStore.stop()
  })
  cleanupStatusUpdate = window.api.onLicenseStatusUpdate?.((info) => {
    licenseInfo.value = info
  })
})

const statusText = computed(() => {
  const map: Record<string, string> = {
    idle: '待机',
    running: '直播中',
    paused: '已暂停'
  }
  return map[liveStore.status] || '待机'
})

const hoursLow = computed(() => {
  return licenseInfo.value?.hoursRemaining != null && licenseInfo.value.hoursRemaining < 10
})

async function handleStart(): Promise<void> {
  actionLoading.value = true
  try {
    // Check license before starting
    const check = await window.api.licenseCanStartLive?.()
    if (check && !check.allowed) {
      alert(check.reason || '授权验证失败，无法开播')
      return
    }

    const result = await liveStore.start(props.roomId)
    if (result?.ok === false) {
      alert(result.error || '启动失败')
      console.error('[Tab4Live] start failed:', result.error || 'unknown error')
    }
  } finally {
    actionLoading.value = false
  }
}

async function handleStop(): Promise<void> {
  if (!window.confirm('确认停止直播？')) return
  actionLoading.value = true
  try {
    await liveStore.stop()
  } finally {
    actionLoading.value = false
  }
}

async function handleManual(): Promise<void> {
  const text = manualText.value.trim()
  if (!text) return
  await liveStore.sendManual(text)
  manualText.value = ''
}

onUnmounted(() => {
  stopElapsedTimer()
  cleanupShouldStop?.()
  cleanupStatusUpdate?.()
})
</script>

<style scoped>
.tab-live {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.live-controls {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 12px 20px;
  background: #ffffff;
  border-bottom: 1px solid #e4e4e7;
  flex-wrap: wrap;
}

.control-status { display: flex; align-items: center; gap: 8px; }

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  animation: none;
}
.dot-idle { background: #a1a1aa; }
.dot-running { background: #16a34a; animation: pulse 1.5s infinite; }
.dot-paused { background: #ca8a04; }

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.status-text { font-size: 13px; color: #71717a; }

.control-buttons { display: flex; gap: 10px; }

button { cursor: pointer; border: none; border-radius: 6px; font-size: 13px; padding: 7px 16px; }

.btn-start { background: #16a34a; color: #fff; }
.btn-start:hover:not(:disabled) { background: #15803d; }
.btn-pause { background: #ca8a04; color: #fff; }
.btn-pause:hover:not(:disabled) { background: #b45309; }
.btn-resume { background: #3b82f6; color: #fff; }
.btn-resume:hover:not(:disabled) { background: #2563eb; }
.btn-stop { background: #dc2626; color: #fff; }
.btn-stop:hover:not(:disabled) { background: #b91c1c; }

button:disabled { opacity: 0.5; cursor: not-allowed; }

.manual-input { display: flex; gap: 8px; flex: 1; min-width: 200px; }
.manual-input input {
  flex: 1;
  padding: 7px 12px;
  background: #f9f9fb;
  border: 1px solid #e4e4e7;
  border-radius: 6px;
  color: #18181b;
  font-size: 13px;
  outline: none;
}
.manual-input input:focus { border-color: #4a9eff; }
.manual-input button {
  background: #f4f4f5;
  color: #18181b;
  padding: 7px 14px;
  border: 1px solid #e4e4e7;
}
.manual-input button:hover { background: #e4e4e7; }

.live-main {
  flex: 1;
  display: flex;
  overflow: hidden;
}

.live-left {
  width: 200px;
  border-right: 1px solid #e4e4e7;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  background: #f8f8fa;
}
.live-center { flex: 1; border-right: 1px solid #e4e4e7; overflow: hidden; }
.live-right { width: 280px; overflow: hidden; }

.live-idle-placeholder {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: #a1a1aa;
  font-size: 15px;
  gap: 8px;
}

.license-summary {
  display: flex;
  gap: 16px;
  font-size: 12px;
  color: #71717a;
}

.elapsed-badge {
  font-size: 12px;
  font-family: 'Consolas', 'Monaco', monospace;
  padding: 2px 8px;
  border-radius: 10px;
  background: #eff6ff;
  color: #2563eb;
  letter-spacing: 0.5px;
}

.hours-badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  background: #dcfce7;
  color: #16a34a;
}
.hours-badge.low {
  background: #fee2e2;
  color: #dc2626;
}

.hours-low {
  color: #dc2626;
}
</style>
