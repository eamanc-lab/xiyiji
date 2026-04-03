<template>
  <div class="danmaku-panel">
    <div class="panel-header">
      <span class="panel-title">弹幕</span>
      <span class="danmaku-count">{{ liveStore.danmakuList.length }}</span>
    </div>

    <div ref="listRef" class="danmaku-list">
      <div
        v-for="msg in liveStore.danmakuList"
        :key="msg.id"
        class="danmaku-item"
        :class="`type-${msg.type}`"
      >
        <span class="msg-time">{{ formatTime(msg.timestamp) }}</span>
        <span class="msg-type-icon">{{ typeIcon(msg.type) }}</span>
        <span class="msg-nick">{{ msg.nickname }}</span>
        <span class="msg-content">{{ msg.content }}</span>
      </div>

      <div v-if="liveStore.danmakuList.length === 0" class="danmaku-empty">
        暂无弹幕
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import { useLiveStore } from '../../stores/live.store'

const liveStore = useLiveStore()
const listRef = ref<HTMLElement | null>(null)
const autoScroll = ref(true)

watch(
  () => liveStore.danmakuList.length,
  async () => {
    if (!autoScroll.value) return
    await nextTick()
    if (listRef.value) {
      listRef.value.scrollTop = 0
    }
  }
)

function formatTime(ts: number): string {
  const d = new Date(ts)
  const h = d.getHours().toString().padStart(2, '0')
  const m = d.getMinutes().toString().padStart(2, '0')
  const s = d.getSeconds().toString().padStart(2, '0')
  return `${h}:${m}:${s}`
}

function typeIcon(type: string): string {
  const icons: Record<string, string> = {
    comment: '💬',
    gift: '🎁',
    follow: '➕',
    enter: '👋'
  }
  return icons[type] || '·'
}
</script>

<style scoped>
.danmaku-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  background: #ffffff;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  background: #f8f8fa;
  border-bottom: 1px solid #e4e4e7;
  flex-shrink: 0;
}

.panel-title {
  font-size: 12px;
  font-weight: 600;
  color: #71717a;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.danmaku-count {
  font-size: 11px;
  color: #71717a;
  background: #e4e4e7;
  padding: 1px 7px;
  border-radius: 10px;
}

.danmaku-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}

.danmaku-item {
  display: flex;
  align-items: baseline;
  gap: 5px;
  padding: 5px 12px;
  border-bottom: 1px solid #f0f0f2;
  font-size: 12px;
  line-height: 1.4;
  transition: background 0.1s;
}
.danmaku-item:hover { background: #f9f9fb; }

.type-gift { background: #fffbeb; }
.type-follow { background: #f0fdf4; }
.type-enter { background: #eff6ff; }

.msg-time {
  color: #a1a1aa;
  font-size: 10px;
  flex-shrink: 0;
  font-family: monospace;
}

.msg-type-icon { font-size: 11px; flex-shrink: 0; }

.msg-nick {
  color: #3b82f6;
  font-weight: 600;
  flex-shrink: 0;
  max-width: 80px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.msg-content {
  color: #18181b;
  word-break: break-all;
  flex: 1;
}

.type-gift .msg-content { color: #ca8a04; }
.type-follow .msg-content { color: #16a34a; }

.danmaku-empty {
  padding: 40px;
  text-align: center;
  color: #a1a1aa;
  font-size: 13px;
}
</style>
