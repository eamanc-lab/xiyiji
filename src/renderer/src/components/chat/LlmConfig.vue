<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useChatStore } from '@/stores/chat.store'

const { t } = useI18n()
const chatStore = useChatStore()

const models = [
  { value: 'qwen-turbo-latest', label: 'Qwen Flash (推荐)' },
  { value: 'qwen-plus', label: 'Qwen Plus' },
  { value: 'qwen-turbo', label: 'Qwen Turbo' }
]
</script>

<template>
  <div class="groupbox">
    <div class="groupbox-title">{{ t('digitalChat.llmConfig') }}</div>
    <div class="groupbox-content">
      <div class="config-row">
        <label>{{ t('digitalChat.model') }}</label>
        <select v-model="chatStore.llmModel" class="config-select">
          <option v-for="m in models" :key="m.value" :value="m.value">{{ m.label }}</option>
        </select>
      </div>
      <div class="config-row vertical">
        <label>{{ t('digitalChat.systemPrompt') }}</label>
        <textarea
          v-model="chatStore.systemPrompt"
          class="config-textarea"
          rows="3"
        ></textarea>
      </div>
    </div>
  </div>
</template>

<style scoped>
.config-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 8px;
}

.config-row.vertical {
  flex-direction: column;
  align-items: stretch;
}

.config-row label {
  min-width: 60px;
  flex-shrink: 0;
}

.config-select {
  flex: 1;
  padding: 6px 8px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-size: 13px;
}

.config-textarea {
  width: 100%;
  padding: 8px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-size: 13px;
  resize: vertical;
  font-family: inherit;
}

.config-textarea:focus {
  border-color: var(--primary-color);
  outline: none;
}
</style>
