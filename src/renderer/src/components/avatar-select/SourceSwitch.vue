<script setup lang="ts">
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

const props = defineProps<{
  modelValue: 'video' | 'camera' | 'video_stream'
}>()

const emit = defineEmits<{
  'update:modelValue': [value: 'video' | 'camera' | 'video_stream']
  selectFile: []
  selectFolder: []
}>()
</script>

<template>
  <div class="source-switch">
    <div class="switch-group">
      <label class="radio-label" :class="{ active: modelValue === 'video' }">
        <input
          type="radio"
          name="source"
          value="video"
          :checked="modelValue === 'video'"
          @change="emit('update:modelValue', 'video')"
        />
        {{ t('avatarSelect.sourceVideo') }}
      </label>
      <label class="radio-label" :class="{ active: modelValue === 'camera' }">
        <input
          type="radio"
          name="source"
          value="camera"
          :checked="modelValue === 'camera'"
          @change="emit('update:modelValue', 'camera')"
        />
        {{ t('avatarSelect.sourceCamera') }}
      </label>
      <label class="radio-label" :class="{ active: modelValue === 'video_stream' }">
        <input
          type="radio"
          name="source"
          value="video_stream"
          :checked="modelValue === 'video_stream'"
          @change="emit('update:modelValue', 'video_stream')"
        />
        视频流式
      </label>
    </div>
    <div class="action-buttons" v-if="modelValue !== 'camera'">
      <button class="action-btn" @click="emit('selectFile')">
        {{ t('avatarSelect.selectFile') }}
      </button>
      <button class="action-btn" @click="emit('selectFolder')">
        {{ t('avatarSelect.selectFolder') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.source-switch {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.switch-group {
  display: flex;
  gap: 16px;
}

.radio-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 4px;
  transition: all 0.2s;
}

.radio-label.active {
  color: var(--primary-color);
  font-weight: 500;
}

.radio-label input[type="radio"] {
  accent-color: var(--primary-color);
}

.action-buttons {
  display: flex;
  gap: 8px;
}

.action-btn {
  padding: 6px 12px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background: var(--bg-card);
  color: var(--text-primary);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s;
}

.action-btn:hover {
  border-color: var(--primary-color);
  color: var(--primary-color);
}
</style>
