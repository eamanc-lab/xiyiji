<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useLiveStore } from '@/stores/live.store'

const { t } = useI18n()
const liveStore = useLiveStore()

const statusLabel = computed(() => {
  switch (liveStore.pipelineStatus) {
    case 'submitting': return '提交中 Submitting...'
    case 'processing':
      if (liveStore.chunkTotal > 1) {
        return `生成中 ${liveStore.chunkIndex}/${liveStore.chunkTotal} Processing...`
      }
      return '生成中 Processing...'
    case 'playing':
      if (liveStore.chunkTotal > 1) {
        return `播放中 ${liveStore.chunkIndex}/${liveStore.chunkTotal}`
      }
      return '播放中 Playing...'
    default: return '空闲 Idle'
  }
})

const statusClass = computed(() => {
  return `status-${liveStore.pipelineStatus}`
})

const progressPercent = computed(() => {
  return liveStore.currentPipelineTask?.progress ?? 0
})
</script>

<template>
  <div class="live-preview">
    <div class="groupbox preview-box">
      <div class="groupbox-title">
        {{ t('digitalLive.preview') }}
      </div>
      <div class="preview-area">
        <!-- Not running: placeholder -->
        <div v-if="!liveStore.videoRunning" class="preview-placeholder">
          <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.5" width="48" height="48">
            <rect x="4" y="8" width="30" height="32" rx="3"/>
            <path d="M34 16l10-6v28l-10-6z"/>
          </svg>
          <p>点击「播放视频」开始预览</p>
          <p>Click "Play Video" to begin</p>
        </div>

        <!-- Running: pipeline status panel -->
        <div v-else class="pipeline-panel">
          <div class="pipeline-status" :class="statusClass">
            <div class="status-dot"></div>
            <span class="status-label">{{ statusLabel }}</span>
          </div>

          <!-- Progress bar for processing -->
          <div class="progress-section" v-if="liveStore.pipelineStatus === 'processing'">
            <div class="progress-bar">
              <div class="progress-fill" :style="{ width: progressPercent + '%' }"></div>
            </div>
            <span class="progress-text">{{ progressPercent }}%</span>
          </div>

          <!-- Current task info -->
          <div class="task-info" v-if="liveStore.currentPipelineTask">
            <div class="task-source">
              来源: {{ liveStore.currentPipelineTask.source }}
            </div>
            <div class="task-text" v-if="liveStore.currentPipelineTask.sourceText">
              {{ liveStore.currentPipelineTask.sourceText.slice(0, 100) }}
              <span v-if="(liveStore.currentPipelineTask.sourceText?.length ?? 0) > 100">...</span>
            </div>
          </div>

          <!-- Error display -->
          <div class="pipeline-error" v-if="liveStore.pipelineError">
            {{ liveStore.pipelineError }}
          </div>

          <!-- Idle message -->
          <div class="idle-message" v-if="liveStore.pipelineStatus === 'idle' && !liveStore.pipelineError">
            <p>播放器已启动，空闲循环播放中</p>
            <p>在左侧选择音频并提交，即可驱动数字人</p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.live-preview {
  flex: 1;
  display: flex;
  flex-direction: column;
}

.preview-box {
  flex: 1;
  display: flex;
  flex-direction: column;
}

.preview-area {
  flex: 1;
  background: var(--bg-secondary);
  border-radius: 0 0 6px 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 300px;
  padding: 20px;
}

.preview-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  color: #666;
}

.preview-placeholder p {
  font-size: 13px;
  margin: 0;
}

/* Pipeline status panel */
.pipeline-panel {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 16px;
  align-items: center;
}

.pipeline-status {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  border-radius: 20px;
  font-size: 14px;
  font-weight: 500;
}

.status-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--text-muted);
}

.status-idle .status-dot { background: var(--text-muted); }
.status-idle { color: var(--text-muted); background: var(--bg-card); }

.status-submitting .status-dot { background: #E37318; animation: blink 1s infinite; }
.status-submitting { color: #E37318; background: rgba(227, 115, 24, 0.1); }

.status-processing .status-dot { background: #0052D9; animation: blink 1s infinite; }
.status-processing { color: #0052D9; background: rgba(0, 82, 217, 0.1); }

.status-playing .status-dot { background: #2BA471; animation: blink 1.5s infinite; }
.status-playing { color: #2BA471; background: rgba(43, 164, 113, 0.1); }

@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

.progress-section {
  width: 80%;
  display: flex;
  align-items: center;
  gap: 8px;
}

.progress-bar {
  flex: 1;
  height: 6px;
  background: var(--border-light);
  border-radius: 3px;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: #0052D9;
  border-radius: 3px;
  transition: width 0.3s;
}

.progress-text {
  font-size: 12px;
  color: var(--text-muted);
  min-width: 36px;
  text-align: right;
}

.task-info {
  text-align: center;
  color: var(--text-secondary);
}

.task-source {
  font-size: 12px;
  color: var(--text-muted);
}

.task-text {
  font-size: 13px;
  margin-top: 4px;
  max-width: 300px;
  line-height: 1.4;
}

.pipeline-error {
  color: #D54941;
  font-size: 13px;
  background: rgba(213, 73, 65, 0.1);
  padding: 8px 12px;
  border-radius: 4px;
  max-width: 300px;
  text-align: center;
}

.idle-message {
  text-align: center;
  color: var(--text-muted);
  font-size: 13px;
  line-height: 1.6;
}

.idle-message p {
  margin: 0;
}
</style>
