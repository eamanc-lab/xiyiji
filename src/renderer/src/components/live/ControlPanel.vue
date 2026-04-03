<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useLiveStore } from '@/stores/live.store'

const { t } = useI18n()
const liveStore = useLiveStore()

const emit = defineEmits<{
  toggleVideo: []
  toggleCamera: []
  toggleAudio: []
}>()
</script>

<template>
  <div class="control-panel">
    <div class="groupbox">
      <div class="groupbox-title">{{ t('digitalLive.controlPanel') }}</div>
      <div class="groupbox-content">
        <div class="control-buttons">
          <button
            class="big-btn btn-red"
            :class="{ active: liveStore.videoRunning, loading: liveStore.videoStarting }"
            @click="emit('toggleVideo')"
            :disabled="liveStore.videoStarting"
          >
            {{ liveStore.videoRunning ? t('digitalLive.stopVideo') : t('digitalLive.startVideo') }}
          </button>
          <div class="btn-hint" v-if="!liveStore.videoRunning">{{ t('digitalLive.playerHint') }}</div>
          <button
            class="big-btn btn-blue"
            :class="{ active: liveStore.cameraRunning, loading: liveStore.cameraStarting }"
            @click="emit('toggleCamera')"
            :disabled="liveStore.cameraStarting"
          >
            {{ liveStore.cameraRunning ? t('digitalLive.stopCamera') : t('digitalLive.startCamera') }}
          </button>
          <button
            class="big-btn btn-green"
            :class="{ active: liveStore.audioRunning, loading: liveStore.audioStarting }"
            @click="emit('toggleAudio')"
            :disabled="liveStore.audioStarting"
          >
            {{ liveStore.audioRunning ? t('digitalLive.stopAudio') : t('digitalLive.startAudio') }}
          </button>
        </div>
        <div class="status-bar">
          <span class="status-item">
            <span class="dot" :class="{ on: liveStore.videoRunning }"></span>
            视频 Video
          </span>
          <span class="status-item">
            <span class="dot" :class="{ on: liveStore.cameraRunning }"></span>
            摄像头 Camera
          </span>
          <span class="status-item">
            <span class="dot" :class="{ on: liveStore.audioRunning }"></span>
            音频 Audio
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.control-buttons {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.big-btn {
  padding: 10px 16px;
  border: none;
  border-radius: 6px;
  color: white;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

.big-btn:hover {
  opacity: 0.85;
}

.big-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.big-btn.active {
  box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.2);
}

.big-btn.loading {
  animation: pulse 1.5s infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.6; }
}

.btn-red { background: #D54941; }
.btn-blue { background: #0052D9; }
.btn-green { background: #2BA471; }

.btn-hint {
  font-size: 11px;
  color: var(--text-muted);
  text-align: center;
  margin-top: -4px;
}

.status-bar {
  display: flex;
  gap: 16px;
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--border-light);
}

.status-item {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-muted);
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-muted);
  transition: background 0.2s;
}

.dot.on {
  background: var(--success-color);
}
</style>
