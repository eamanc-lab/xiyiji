<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { ref } from 'vue'
import type { VideoItem } from '@/stores/avatar-select.store'

const { t } = useI18n()

const props = defineProps<{
  videos: VideoItem[]
  selectedId: string | null
}>()

const emit = defineEmits<{
  select: [id: string]
  addToPlaylist: [video: VideoItem]
  remove: [id: string]
}>()

const contextMenuVisible = ref(false)
const contextMenuX = ref(0)
const contextMenuY = ref(0)
const contextMenuVideo = ref<VideoItem | null>(null)

function onContextMenu(e: MouseEvent, video: VideoItem) {
  e.preventDefault()
  contextMenuX.value = e.clientX
  contextMenuY.value = e.clientY
  contextMenuVideo.value = video
  contextMenuVisible.value = true
}

function closeContextMenu() {
  contextMenuVisible.value = false
  contextMenuVideo.value = null
}

function handleAddToPlaylist() {
  if (contextMenuVideo.value) {
    emit('addToPlaylist', contextMenuVideo.value)
  }
  closeContextMenu()
}

function handleRemove() {
  if (contextMenuVideo.value) {
    emit('remove', contextMenuVideo.value.id)
  }
  closeContextMenu()
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}
</script>

<template>
  <div class="video-library" @click="closeContextMenu">
    <div class="library-header">
      {{ t('avatarSelect.videoLibrary') }}
      <span class="count">({{ videos.length }})</span>
    </div>
    <div class="library-list" v-if="videos.length > 0">
      <div
        v-for="video in videos"
        :key="video.id"
        class="video-item"
        :class="{ selected: video.id === selectedId }"
        @click="emit('select', video.id)"
        @contextmenu="onContextMenu($event, video)"
      >
        <div class="video-thumb">
          <img v-if="video.thumbnail" :src="'file:///' + video.thumbnail" alt="" />
          <div v-else class="thumb-placeholder">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="24" height="24">
              <rect x="2" y="4" width="15" height="16" rx="2"/>
              <path d="M17 8l5-3v14l-5-3z"/>
            </svg>
          </div>
        </div>
        <div class="video-info">
          <div class="video-name" :title="video.name">{{ video.name }}</div>
          <div class="video-meta">
            <span v-if="video.duration">{{ formatDuration(video.duration) }}</span>
            <span v-if="video.width">{{ video.width }}x{{ video.height }}</span>
          </div>
        </div>
      </div>
    </div>
    <div class="empty-state" v-else>
      {{ t('avatarSelect.emptyLibrary') }}
    </div>

    <!-- Context Menu -->
    <Teleport to="body">
      <div
        v-if="contextMenuVisible"
        class="context-menu"
        :style="{ left: contextMenuX + 'px', top: contextMenuY + 'px' }"
      >
        <div class="menu-item" @click="handleAddToPlaylist">
          {{ t('avatarSelect.addToPlaylist') }}
        </div>
        <div class="menu-item danger" @click="handleRemove">
          {{ t('common.delete') }}
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.video-library {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.library-header {
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

.library-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px;
}

.video-item {
  display: flex;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 4px;
  cursor: pointer;
  transition: background 0.15s;
}

.video-item:hover {
  background: var(--bg-hover);
}

.video-item.selected {
  background: var(--bg-tertiary);
  border-left: 3px solid var(--primary-color);
}

.video-thumb {
  width: 64px;
  height: 48px;
  border-radius: 4px;
  overflow: hidden;
  flex-shrink: 0;
  background: var(--bg-secondary);
}

.video-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.thumb-placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
}

.video-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.video-name {
  font-size: 13px;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.video-meta {
  font-size: 11px;
  color: var(--text-muted);
  display: flex;
  gap: 8px;
  margin-top: 2px;
}

.empty-state {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  font-size: 13px;
  padding: 20px;
}

.context-menu {
  position: fixed;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  z-index: 1000;
  min-width: 140px;
  padding: 4px;
}

.menu-item {
  padding: 6px 12px;
  font-size: 13px;
  color: var(--text-primary);
  cursor: pointer;
  border-radius: 4px;
  transition: background 0.15s;
}

.menu-item:hover {
  background: var(--bg-hover);
}

.menu-item.danger {
  color: var(--error-color);
}
</style>
