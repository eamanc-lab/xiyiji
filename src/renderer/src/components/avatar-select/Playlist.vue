<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { VideoItem } from '@/stores/avatar-select.store'

const { t } = useI18n()

const props = defineProps<{
  items: VideoItem[]
}>()

const emit = defineEmits<{
  remove: [id: string]
  select: [id: string]
}>()

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}
</script>

<template>
  <div class="playlist">
    <div class="playlist-header">
      {{ t('avatarSelect.playlist') }}
      <span class="count">({{ items.length }})</span>
    </div>
    <div class="playlist-items" v-if="items.length > 0">
      <div
        v-for="(item, index) in items"
        :key="item.id"
        class="playlist-item"
        @click="emit('select', item.id)"
      >
        <span class="item-index">{{ index + 1 }}</span>
        <div class="item-info">
          <div class="item-name" :title="item.name">{{ item.name }}</div>
          <span class="item-duration" v-if="item.duration">{{ formatDuration(item.duration) }}</span>
        </div>
        <button class="remove-btn" @click.stop="emit('remove', item.id)" :title="t('avatarSelect.removeFromPlaylist')">
          <svg viewBox="0 0 12 12" width="12" height="12">
            <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" stroke-width="1.5"/>
          </svg>
        </button>
      </div>
    </div>
    <div class="empty-state" v-else>
      <p>右键视频 → 加入清单</p>
      <p>Right-click → Add to playlist</p>
    </div>
  </div>
</template>

<style scoped>
.playlist {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.playlist-header {
  padding: 8px 12px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-secondary);
}

.count {
  color: var(--text-muted);
  font-weight: normal;
}

.playlist-items {
  flex: 1;
  overflow-y: auto;
  padding: 4px;
}

.playlist-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 4px;
  cursor: pointer;
  transition: background 0.15s;
}

.playlist-item:hover {
  background: var(--bg-hover);
}

.item-index {
  width: 20px;
  text-align: center;
  font-size: 12px;
  color: var(--text-muted);
  flex-shrink: 0;
}

.item-info {
  flex: 1;
  min-width: 0;
}

.item-name {
  font-size: 13px;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.item-duration {
  font-size: 11px;
  color: var(--text-muted);
}

.remove-btn {
  width: 20px;
  height: 20px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  flex-shrink: 0;
  opacity: 0;
  transition: all 0.15s;
}

.playlist-item:hover .remove-btn {
  opacity: 1;
}

.remove-btn:hover {
  color: var(--error-color);
  background: var(--bg-hover);
}

.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  font-size: 12px;
  gap: 4px;
  padding: 20px;
}
</style>
