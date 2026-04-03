<script setup lang="ts">
import { ref, watch } from 'vue'

const props = defineProps<{ src: string | null }>()

const videoRef = ref<HTMLVideoElement | null>(null)
const isPlaying = ref(false)
const currentTime = ref(0)
const totalDuration = ref(0)
const volume = ref(1)
const isMuted = ref(false)
const playbackRate = ref(1)
const isFullscreen = ref(false)
const isLoop = ref(false)

function togglePlay() {
  if (!videoRef.value) return
  if (videoRef.value.paused) {
    videoRef.value.play()
    isPlaying.value = true
  } else {
    videoRef.value.pause()
    isPlaying.value = false
  }
}

function onTimeUpdate() {
  if (!videoRef.value) return
  currentTime.value = videoRef.value.currentTime
}

function onLoadedMetadata() {
  if (!videoRef.value) return
  totalDuration.value = videoRef.value.duration
}

function onEnded() {
  isPlaying.value = false
}

function seek(e: Event) {
  const val = (e.target as HTMLInputElement).value
  if (videoRef.value) {
    videoRef.value.currentTime = Number(val)
  }
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0')
  const s = Math.floor(seconds % 60).toString().padStart(2, '0')
  return `${m}:${s}`
}

function toggleFullscreen() {
  const container = videoRef.value?.parentElement?.parentElement
  if (!container) return
  if (!document.fullscreenElement) {
    container.requestFullscreen()
    isFullscreen.value = true
  } else {
    document.exitFullscreen()
    isFullscreen.value = false
  }
}

function setRate(rate: number) {
  playbackRate.value = rate
  if (videoRef.value) videoRef.value.playbackRate = rate
}

function toggleMute() {
  isMuted.value = !isMuted.value
  if (videoRef.value) videoRef.value.muted = isMuted.value
}

function setVolume(e: Event) {
  const val = Number((e.target as HTMLInputElement).value)
  volume.value = val
  if (videoRef.value) {
    videoRef.value.volume = val
    isMuted.value = val === 0
  }
}

function toggleLoop() {
  isLoop.value = !isLoop.value
  if (videoRef.value) videoRef.value.loop = isLoop.value
}

function stepFrame(forward: boolean) {
  if (!videoRef.value) return
  const fps = 25
  const step = 1 / fps
  videoRef.value.currentTime = Math.max(0, videoRef.value.currentTime + (forward ? step : -step))
}

watch(() => props.src, () => {
  isPlaying.value = false
  currentTime.value = 0
})
</script>

<template>
  <div class="video-player" v-if="src">
    <div class="player-container">
      <video
        ref="videoRef"
        :src="'file:///' + src.replace(/\\\\/g, '/')"
        @timeupdate="onTimeUpdate"
        @loadedmetadata="onLoadedMetadata"
        @ended="onEnded"
        @click="togglePlay"
        class="player-video"
      />
    </div>

    <div class="player-controls">
      <!-- Frame back -->
      <button class="ctrl-btn" @click="stepFrame(false)" title="上一帧">
        <svg viewBox="0 0 16 16" fill="currentColor" width="10" height="10">
          <path d="M3 2v12h2V2H3zm10 0L6 8l7 6V2z"/>
        </svg>
      </button>

      <!-- Play/Pause -->
      <button class="ctrl-btn" @click="togglePlay">
        <svg v-if="!isPlaying" viewBox="0 0 16 16" fill="currentColor" width="14" height="14">
          <polygon points="3,1 14,8 3,15"/>
        </svg>
        <svg v-else viewBox="0 0 16 16" fill="currentColor" width="14" height="14">
          <rect x="2" y="1" width="4" height="14"/>
          <rect x="10" y="1" width="4" height="14"/>
        </svg>
      </button>

      <!-- Frame forward -->
      <button class="ctrl-btn" @click="stepFrame(true)" title="下一帧">
        <svg viewBox="0 0 16 16" fill="currentColor" width="10" height="10">
          <path d="M11 2v12h2V2h-2zM3 2l7 6-7 6V2z"/>
        </svg>
      </button>

      <span class="time-display">{{ formatTime(currentTime) }} / {{ formatTime(totalDuration) }}</span>

      <input
        type="range"
        class="seek-bar"
        :min="0"
        :max="totalDuration"
        :value="currentTime"
        step="0.1"
        @input="seek"
      />

      <!-- Volume -->
      <button class="ctrl-btn" @click="toggleMute" :title="isMuted ? '取消静音' : '静音'">
        <svg v-if="!isMuted && volume > 0" viewBox="0 0 16 16" fill="currentColor" width="12" height="12">
          <path d="M8 2L4 6H1v4h3l4 4V2zm2.5 2.5c.8.8 1.3 2 1.3 3.5s-.5 2.7-1.3 3.5"/>
        </svg>
        <svg v-else viewBox="0 0 16 16" fill="currentColor" width="12" height="12">
          <path d="M8 2L4 6H1v4h3l4 4V2zm3.5 4L14 8.5M14 6l-2.5 2.5"/>
        </svg>
      </button>
      <input
        type="range"
        class="volume-bar"
        :min="0"
        :max="1"
        :step="0.05"
        :value="volume"
        @input="setVolume"
      />

      <!-- Loop -->
      <button class="ctrl-btn" :class="{ active: isLoop }" @click="toggleLoop" title="循环">
        <svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12">
          <path d="M11 2l3 3-3 3M5 14l-3-3 3-3M14 5H6a4 4 0 000 8h0M2 11h8a4 4 0 000-8h0"/>
        </svg>
      </button>

      <!-- Speed -->
      <select class="rate-select" :value="playbackRate" @change="setRate(Number(($event.target as HTMLSelectElement).value))">
        <option :value="0.5">0.5x</option>
        <option :value="1">1x</option>
        <option :value="1.5">1.5x</option>
        <option :value="2">2x</option>
      </select>

      <!-- Fullscreen -->
      <button class="ctrl-btn" @click="toggleFullscreen" title="全屏">
        <svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12">
          <path d="M1 1h5v1.5H2.5V7H1V1zm9 0h5v6h-1.5V2.5H10V1zM1 10h1.5v3.5H7V15H1v-5zm12.5 0H15v5h-6v-1.5h4.5V10z"/>
        </svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
.video-player {
  display: flex;
  flex-direction: column;
  flex: 1;
}

.player-container {
  flex: 1;
  background: #000;
  border-radius: 6px;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
}

.player-video {
  max-width: 100%;
  max-height: 100%;
  cursor: pointer;
}

.player-controls {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 0 0;
}

.ctrl-btn {
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.ctrl-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.ctrl-btn.active {
  color: var(--primary-color);
}

.time-display {
  font-size: 11px;
  color: var(--text-muted);
  min-width: 80px;
  flex-shrink: 0;
}

.seek-bar {
  flex: 1;
  height: 4px;
  -webkit-appearance: none;
  background: var(--border-color);
  border-radius: 2px;
  cursor: pointer;
}

.seek-bar::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--primary-color);
  cursor: pointer;
}

.volume-bar {
  width: 60px;
  height: 3px;
  -webkit-appearance: none;
  background: var(--border-color);
  border-radius: 2px;
  cursor: pointer;
  flex-shrink: 0;
}

.volume-bar::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--text-secondary);
  cursor: pointer;
}

.rate-select {
  background: transparent;
  border: 1px solid var(--border-color);
  color: var(--text-secondary);
  font-size: 11px;
  padding: 2px 4px;
  border-radius: 4px;
  cursor: pointer;
  flex-shrink: 0;
}

.rate-select option {
  background: var(--bg-card);
}
</style>
