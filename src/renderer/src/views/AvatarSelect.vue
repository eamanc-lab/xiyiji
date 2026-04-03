<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useAvatarSelectStore } from '@/stores/avatar-select.store'
import type { VideoItem } from '@/stores/avatar-select.store'
import SourceSwitch from '@/components/avatar-select/SourceSwitch.vue'
import VideoLibrary from '@/components/avatar-select/VideoLibrary.vue'
import Playlist from '@/components/avatar-select/Playlist.vue'
import { computed, ref } from 'vue'
import { v4 as uuidv4 } from 'uuid'

const { t } = useI18n()
const store = useAvatarSelectStore()
const cameraDevices = ref<MediaDeviceInfo[]>([])
const cameraStream = ref<MediaStream | null>(null)
const cameraVideo = ref<HTMLVideoElement | null>(null)

const currentSelection = computed(() => {
  if (store.sourceType === 'camera') return '摄像头模式'
  if (store.sourceType === 'video_stream') {
    return store.currentVideo?.name || '视频流式模式'
  }
  return store.currentVideo?.name || '未选择'
})

async function handleSelectFile() {
  const result = await window.api.selectVideoFiles()
  if (result.paths && result.paths.length > 0) {
    for (const path of result.paths) {
      await addVideoToLibrary(path)
    }
  }
}

async function handleSelectFolder() {
  const result = await window.api.selectDirectory()
  if (result.path) {
    const scanResult = await window.api.scanVideoDir(result.path)
    if (scanResult.paths) {
      for (const path of scanResult.paths) {
        await addVideoToLibrary(path)
      }
    }
  }
}

async function addVideoToLibrary(path: string) {
  const info = await window.api.getVideoInfo(path)
  if (!info.exists) return

  const video: VideoItem = {
    id: uuidv4(),
    name: info.name || path.split(/[/\\]/).pop() || 'video',
    path,
    thumbnail: '',
    duration: info.duration || 0,
    width: info.width || 0,
    height: info.height || 0,
  }

  store.addToLibrary(video)

  try {
    const userDataPath = await window.api.getUserDataPath()
    const thumbPath = `${userDataPath}/thumbnails/${video.id}.jpg`
    const result = await window.api.extractThumbnail(path, thumbPath)
    if (result.success) {
      const existing = store.videoLibrary.find((item) => item.id === video.id)
      if (existing) {
        existing.thumbnail = thumbPath
      }
    }
  } catch {
    // Thumbnail extraction is optional.
  }
}

function handleAddToPlaylist(video: VideoItem) {
  store.addToPlaylist(video)
}

function handleRemoveFromLibrary(id: string) {
  store.removeFromLibrary(id)
}

function handleRemoveFromPlaylist(id: string) {
  store.removeFromPlaylist(id)
}

function handleSelectVideo(id: string) {
  store.selectVideo(id)
}

async function enumerateCameras() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    cameraDevices.value = devices.filter((device) => device.kind === 'videoinput')
  } catch {
    cameraDevices.value = []
  }
}

async function startCamera(deviceId?: string) {
  stopCamera()
  try {
    const constraints: MediaStreamConstraints = {
      video: deviceId ? { deviceId: { exact: deviceId } } : true,
    }
    cameraStream.value = await navigator.mediaDevices.getUserMedia(constraints)
    if (cameraVideo.value) {
      cameraVideo.value.srcObject = cameraStream.value
    }
  } catch (err) {
    console.error('Failed to start camera:', err)
  }
}

function stopCamera() {
  if (cameraStream.value) {
    cameraStream.value.getTracks().forEach((track) => track.stop())
    cameraStream.value = null
  }
}

async function onSourceChange(type: 'video' | 'camera' | 'video_stream') {
  store.setSourceType(type)
  if (type === 'camera') {
    await enumerateCameras()
    if (cameraDevices.value.length > 0) {
      await startCamera()
    }
    return
  }

  stopCamera()
}
</script>

<template>
  <div class="avatar-select-page">
    <div class="page-header">
      <h2>{{ t('avatarSelect.title') }}</h2>
      <SourceSwitch
        :modelValue="store.sourceType"
        @update:modelValue="onSourceChange"
        @selectFile="handleSelectFile"
        @selectFolder="handleSelectFolder"
      />
    </div>

    <div v-if="store.sourceType !== 'camera'" class="page-body">
      <div class="panel left-panel">
        <VideoLibrary
          :videos="store.videoLibrary"
          :selectedId="store.currentVideoId"
          @select="handleSelectVideo"
          @addToPlaylist="handleAddToPlaylist"
          @remove="handleRemoveFromLibrary"
        />
      </div>
      <div class="panel right-panel">
        <Playlist
          :items="store.playlist"
          @remove="handleRemoveFromPlaylist"
          @select="handleSelectVideo"
        />
      </div>
    </div>

    <div v-else class="page-body camera-mode">
      <div class="camera-preview">
        <video ref="cameraVideo" autoplay muted playsinline class="camera-feed"></video>
        <div v-if="cameraDevices.length === 0" class="no-camera">
          未检测到摄像头
        </div>
      </div>
      <div v-if="cameraDevices.length > 0" class="camera-controls">
        <label class="control-label">
          摄像头设备
          <select
            class="device-select"
            @change="startCamera(($event.target as HTMLSelectElement).value)"
          >
            <option
              v-for="device in cameraDevices"
              :key="device.deviceId"
              :value="device.deviceId"
            >
              {{ device.label || `Camera ${cameraDevices.indexOf(device) + 1}` }}
            </option>
          </select>
        </label>
      </div>
    </div>

    <div class="page-footer">
      <span class="current-label">{{ t('avatarSelect.currentSelection') }}:</span>
      <span class="current-value">{{ currentSelection }}</span>
    </div>
  </div>
</template>

<style scoped>
.avatar-select-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  gap: 12px;
}

.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.page-header h2 {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
}

.page-body {
  display: flex;
  flex: 1;
  gap: 12px;
  min-height: 0;
}

.panel {
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-card);
  overflow: hidden;
}

.left-panel {
  flex: 1;
}

.right-panel {
  width: 280px;
}

.camera-mode {
  flex-direction: column;
  align-items: center;
}

.camera-preview {
  flex: 1;
  width: 100%;
  max-width: 640px;
  background: #000;
  border-radius: 6px;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
}

.camera-feed {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.no-camera {
  color: var(--text-muted);
  font-size: 14px;
}

.camera-controls {
  padding: 12px 0;
}

.control-label {
  font-size: 13px;
  color: var(--text-secondary);
  display: flex;
  align-items: center;
  gap: 8px;
}

.device-select {
  padding: 6px 8px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background: var(--bg-card);
  color: var(--text-primary);
  font-size: 13px;
}

.page-footer {
  padding: 8px 0;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

.current-label {
  color: var(--text-muted);
}

.current-value {
  color: var(--text-primary);
  font-weight: 500;
}
</style>
