<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useLiveStore } from '@/stores/live.store'
import { useAvatarSelectStore } from '@/stores/avatar-select.store'
import AudioInputPanel from '@/components/live/AudioInputPanel.vue'
import ControlPanel from '@/components/live/ControlPanel.vue'
import LivePreview from '@/components/live/LivePreview.vue'

const { t } = useI18n()
const liveStore = useLiveStore()
const avatarStore = useAvatarSelectStore()

onMounted(() => {
  liveStore.initPipelineListeners()
})

onUnmounted(() => {
  liveStore.destroyPipelineListeners()
})

async function toggleVideo() {
  if (liveStore.videoRunning) {
    // Stop: cancel pipeline + close player
    await window.api.pipelineCancel()
    await window.api.playerStop()
    await window.api.playerClose()
    liveStore.setVideoRunning(false)
    return
  }

  // Build playlist from avatar selection
  const paths: string[] = []
  if (avatarStore.playlist.length > 0) {
    for (const item of avatarStore.playlist) {
      paths.push(item.path)
    }
  } else if (avatarStore.currentVideo) {
    paths.push(avatarStore.currentVideo.path)
  }

  if (paths.length === 0) {
    console.warn('No video selected in avatar tab')
    return
  }

  liveStore.videoStarting = true
  try {
    // Set avatar video for pipeline (use first video in playlist)
    await window.api.pipelineSetAvatar(paths[0])
    const result =
      avatarStore.sourceType === 'video_stream'
        ? await window.api.playerOpenVideoStream(paths[0])
        : await window.api.playerOpen(paths)
    if (result.success) {
      liveStore.setVideoRunning(true)
    } else {
      console.error('Failed to open player:', result.error)
      liveStore.videoStarting = false
    }
  } catch (err) {
    console.error('Player open error:', err)
    liveStore.videoStarting = false
  }
}

async function toggleCamera() {
  if (liveStore.cameraRunning) {
    await window.api.cameraStop()
    liveStore.setCameraRunning(false)
    return
  }

  if (!liveStore.videoRunning) {
    console.warn('Please start video first')
    return
  }

  liveStore.cameraStarting = true
  try {
    const status = await window.api.cameraStatus()
    if (!status.ffmpegAvailable) {
      console.error('FFmpeg not found')
      liveStore.cameraStarting = false
      return
    }
    if (!status.obsInstalled) {
      console.error('OBS Virtual Camera not found')
      liveStore.cameraStarting = false
      return
    }
    const result = await window.api.cameraStart()
    if (result.success) {
      liveStore.setCameraRunning(true)
    } else {
      console.error('Camera start failed:', result.error)
      liveStore.cameraStarting = false
    }
  } catch (err) {
    console.error('Camera error:', err)
    liveStore.cameraStarting = false
  }
}

async function toggleAudio() {
  if (liveStore.audioRunning) {
    // Stop: cancel any pending pipeline tasks
    await window.api.pipelineCancel()
    liveStore.setAudioRunning(false)
    return
  }

  if (!liveStore.videoRunning) {
    console.warn('Please start video first')
    return
  }

  liveStore.audioStarting = true

  try {
    if (liveStore.audioMode === 'tts') {
      // TTS mode: synthesize + F2F in one shot
      if (!liveStore.ttsText.trim()) {
        liveStore.audioStarting = false
        return
      }
      const result = await window.api.pipelineSubmitTts(
        liveStore.ttsText,
        liveStore.ttsVoice,
        liveStore.ttsSpeed
      )
      if (!result.success) {
        console.error('Pipeline TTS submit failed:', result.error)
      }
    } else if (liveStore.audioMode === 'file') {
      // File mode: submit audio file to pipeline
      if (!liveStore.audioFilePath) {
        liveStore.audioStarting = false
        return
      }
      const result = await window.api.pipelineSubmitAudio(
        liveStore.audioFilePath,
        'file'
      )
      if (!result.success) {
        console.error('Pipeline audio submit failed:', result.error)
      }
    }
    // Mic mode: mark as running (real-time handled elsewhere in future)
    liveStore.setAudioRunning(true)
  } catch (err) {
    console.error('Audio toggle error:', err)
    liveStore.audioStarting = false
  }
}
</script>

<template>
  <div class="digital-live-page">
    <div class="page-header">
      <h2>{{ t('digitalLive.title') }}</h2>
      <span class="selected-avatar" v-if="avatarStore.currentVideo">
        形象: {{ avatarStore.currentVideo.name }}
      </span>
      <span class="no-avatar" v-else>
        请先在「形象选择」Tab 选择视频
      </span>
    </div>
    <div class="page-body">
      <div class="left-column">
        <AudioInputPanel />
        <ControlPanel
          @toggleVideo="toggleVideo"
          @toggleCamera="toggleCamera"
          @toggleAudio="toggleAudio"
        />
      </div>
      <div class="right-column">
        <LivePreview />
      </div>
    </div>
  </div>
</template>

<style scoped>
.digital-live-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  gap: 12px;
}

.page-header {
  display: flex;
  align-items: center;
  gap: 16px;
}

.page-header h2 {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
}

.selected-avatar {
  font-size: 12px;
  color: var(--success-color);
  background: rgba(43, 164, 113, 0.1);
  padding: 2px 8px;
  border-radius: 4px;
}

.no-avatar {
  font-size: 12px;
  color: var(--warning-color);
}

.page-body {
  display: flex;
  flex: 1;
  gap: 12px;
  min-height: 0;
}

.left-column {
  width: 360px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow-y: auto;
}

.right-column {
  flex: 1;
  display: flex;
  flex-direction: column;
}
</style>
