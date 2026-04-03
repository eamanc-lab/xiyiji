<template>
  <div class="queue-panel">
    <div class="panel-header">
      <span class="panel-title">播放队列 ({{ liveStore.queue.length }})</span>
      <span v-if="playingIndex >= 0" class="playing-pos">#{{ playingIndex + 1 }}</span>
      <div class="header-actions">
        <button class="action-btn" @click="liveStore.skipCurrent()">跳过</button>
        <button class="action-btn danger" @click="liveStore.clearQueue()">清空</button>
      </div>
    </div>

    <div ref="queueListRef" class="queue-list">
      <div
        v-for="(item, index) in liveStore.queue"
        :key="item.id"
        class="queue-item"
        :class="{
          'is-current': item.id === playingId,
          'is-done': item.status === 'done',
          'is-pending': item.status === 'pending',
          'is-ready': item.status === 'ready',
          'is-processing': item.status === 'playing'
        }"
      >
        <span class="item-index">{{ index + 1 }}</span>

        <span class="item-status-icon">
          <template v-if="item.id === playingId">
            <span class="eq"><span class="b"></span><span class="b"></span><span class="b"></span></span>
          </template>
          <template v-else>{{ statusIcon(item.status) }}</template>
        </span>

        <span class="item-source" :class="`source-${item.source}`">{{ sourceLabel(item) }}</span>

        <div class="item-copy">
          <div class="item-text">{{ item.text }}</div>
          <div v-if="item.translatedText" class="item-translation">{{ item.translatedText }}</div>
        </div>

        <div class="item-right">
          <span v-if="item.id === playingId" class="item-badge badge-playing">播放中</span>
          <span v-else-if="item.status === 'pending'" class="item-badge badge-pending">等待TTS</span>
          <span v-else-if="item.status === 'ready'" class="item-badge badge-ready">就绪</span>
          <span v-else-if="item.status === 'playing'" class="item-badge badge-processing">处理中</span>
          <span v-else-if="item.status === 'buffered'" class="item-badge badge-buffered">待播放</span>
          <span v-else-if="item.status === 'done'" class="item-badge badge-done">已完成</span>
        </div>
      </div>

      <div v-if="liveStore.queue.length === 0" class="queue-empty">队列为空</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useLiveStore } from '../../stores/live.store'

const liveStore = useLiveStore()
const queueListRef = ref<HTMLDivElement | null>(null)

const playingId = computed(() => {
  const audible = liveStore.queue.find((item) => item.isAudible)
  if (audible) return audible.id
  const buffered = liveStore.queue.find((item) => item.status === 'buffered')
  if (buffered) return buffered.id
  const playing = liveStore.queue.find((item) => item.status === 'playing')
  return playing ? playing.id : ''
})

const playingIndex = computed(() => {
  if (!playingId.value) return -1
  return liveStore.queue.findIndex((item) => item.id === playingId.value)
})

function statusIcon(status: string): string {
  return ({
    pending: '○',
    ready: '◌',
    playing: '◐',
    buffered: '◑',
    done: '✓',
    dropped: '×'
  } as Record<string, string>)[status] || '·'
}

function sourceLabel(item: { source: string; meta?: { role?: string; aiMode?: string | null } | null }): string {
  const meta = item.meta
  if (meta?.role === 'interaction') return '互动'
  if (meta?.role === 'mainline' && meta.aiMode === 'ordered_generalize_ai') return '顺序泛化AI'
  if (meta?.role === 'mainline' && (meta.aiMode === 'semi_ai' || meta.aiMode === 'no_ai')) return '原文循环'
  return ({ ai: 'AI', shortcut: '快捷', manual: '手动' } as Record<string, string>)[item.source] || item.source
}

let prevId = ''
watch(playingId, (id) => {
  if (!id || id === prevId) return
  prevId = id
  nextTick(() => {
    const el = queueListRef.value?.querySelector('.is-current') as HTMLElement | null
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  })
})
</script>

<style scoped>
.queue-panel { display: flex; flex-direction: column; height: 100%; background: #fff; overflow: hidden; }

.panel-header {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 12px; background: #fafafa; border-bottom: 1px solid #e5e5e5; flex-shrink: 0;
}
.panel-title { font-size: 12px; font-weight: 600; color: #888; }
.playing-pos { font-size: 11px; color: #d97706; font-weight: 700; }
.header-actions { margin-left: auto; display: flex; gap: 6px; }
.action-btn {
  font-size: 11px; padding: 2px 10px; border: 1px solid #ddd; border-radius: 4px;
  background: transparent; color: #888; cursor: pointer;
}
.action-btn:hover { color: #333; border-color: #aaa; }
.action-btn.danger:hover { color: #dc2626; border-color: #dc2626; }

.queue-list { flex: 1; overflow-y: auto; padding: 2px 0; }

.queue-item {
  display: flex; align-items: flex-start; gap: 6px;
  padding: 6px 10px; border-bottom: 1px solid #f0f0f0;
  border-left: 4px solid transparent;
  background: #fff;
}

.item-index {
  flex-shrink: 0; width: 22px; text-align: right;
  font-size: 11px; color: #bbb; font-variant-numeric: tabular-nums;
}

.item-status-icon { flex-shrink: 0; width: 18px; text-align: center; font-size: 12px; color: #bbb; }

.item-source {
  flex-shrink: 0; font-size: 9px; padding: 1px 5px;
  border-radius: 3px; font-weight: 600;
}
.source-ai { background: #f3f3f3; color: #999; }
.source-shortcut { background: #f3f0ff; color: #8b5cf6; }
.source-manual { background: #fef9ee; color: #b98024; }

.item-copy {
  flex: 1;
  min-width: 0;
}

.item-text {
  font-size: 13px; color: #333; line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
}

.item-translation {
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.45;
  color: #6b7280;
  white-space: pre-wrap;
  word-break: break-word;
}

.item-right { flex-shrink: 0; align-self: center; }
.item-badge { font-size: 10px; padding: 1px 6px; border-radius: 3px; }
.badge-pending { background: #fef9c3; color: #ca8a04; }
.badge-ready { background: #dcfce7; color: #16a34a; }
.badge-playing { background: #f59e0b; color: #fff; font-weight: 600; animation: pulse 1.5s infinite; }
.badge-processing { background: #dbeafe; color: #2563eb; animation: pulse 1.5s infinite; }
.badge-buffered { background: #fef3c7; color: #d97706; }
.badge-done { background: #f4f4f5; color: #a1a1aa; }

.is-done { opacity: 0.45; }
.is-done .item-text { color: #999; }
.is-done .item-translation { color: #9ca3af; }
.is-pending .item-text { color: #999; }
.is-pending .item-translation { color: #9ca3af; }
.is-processing { border-left-color: #60a5fa; }
.is-processing .item-text { color: #1e40af; }

.is-current {
  background: #fffbeb !important;
  border-left-color: #f59e0b !important;
  box-shadow: 0 2px 8px rgba(245, 158, 11, 0.2);
  padding-top: 9px; padding-bottom: 9px;
  position: relative; z-index: 1;
}
.is-current .item-index { color: #b45309; font-weight: 700; font-size: 13px; }
.is-current .item-text { color: #78350f; font-weight: 600; font-size: 14px; }
.is-current .item-translation { color: #92400e; }
.is-current .item-source.source-ai { background: #fef3c7; color: #d97706; }

.eq { display: inline-flex; align-items: flex-end; gap: 2px; height: 14px; }
.eq .b {
  width: 3px; border-radius: 1px; background: #f59e0b;
  animation: eqb .7s ease-in-out infinite;
}
.eq .b:nth-child(1) { height: 5px; animation-delay: 0s; }
.eq .b:nth-child(2) { height: 10px; animation-delay: .12s; }
.eq .b:nth-child(3) { height: 4px; animation-delay: .24s; }
@keyframes eqb { 0%,100% { transform: scaleY(.35); } 50% { transform: scaleY(1); } }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .55; } }

.queue-empty { padding: 40px; text-align: center; color: #ccc; font-size: 13px; }
</style>
