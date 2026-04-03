<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

const emit = defineEmits<{
  send: [text: string]
}>()

const inputText = ref('')

function handleSend() {
  const text = inputText.value.trim()
  if (!text) return
  emit('send', text)
  inputText.value = ''
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    handleSend()
  }
}
</script>

<template>
  <div class="chat-input-area">
    <input
      type="text"
      class="chat-input"
      v-model="inputText"
      :placeholder="t('digitalChat.inputPlaceholder')"
      @keydown="handleKeydown"
    />
    <button class="send-btn" @click="handleSend" :disabled="!inputText.trim()">
      {{ t('digitalChat.send') }}
    </button>
  </div>
</template>

<style scoped>
.chat-input-area {
  display: flex;
  gap: 8px;
  padding: 12px;
  border-top: 1px solid var(--border-color);
}

.chat-input {
  flex: 1;
  padding: 8px 12px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 13px;
  outline: none;
  font-family: inherit;
}

.chat-input:focus {
  border-color: var(--primary-color);
}

.send-btn {
  padding: 8px 16px;
  border: none;
  border-radius: 6px;
  background: var(--primary-color);
  color: white;
  font-size: 13px;
  cursor: pointer;
  transition: opacity 0.2s;
}

.send-btn:hover {
  opacity: 0.85;
}

.send-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
