<script setup lang="ts">
import { nextTick, watch, ref } from 'vue'
import type { ChatMessage } from '@/stores/chat.store'

const props = defineProps<{
  messages: ChatMessage[]
}>()

const containerRef = ref<HTMLDivElement | null>(null)
const playingAudioId = ref<string | null>(null)
let currentAudio: HTMLAudioElement | null = null

watch(() => props.messages.length, async () => {
  await nextTick()
  if (containerRef.value) {
    containerRef.value.scrollTop = containerRef.value.scrollHeight
  }
})

function formatTime(ts: number): string {
  const d = new Date(ts)
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}

function playAudio(msg: ChatMessage) {
  if (!msg.audioPath) return

  // Stop currently playing audio
  if (currentAudio) {
    currentAudio.pause()
    currentAudio = null
  }

  if (playingAudioId.value === msg.id) {
    playingAudioId.value = null
    return
  }

  const fileUrl = 'file:///' + msg.audioPath.replace(/\\/g, '/').replace(/^\//, '')
  currentAudio = new Audio(fileUrl)
  playingAudioId.value = msg.id

  currentAudio.addEventListener('ended', () => {
    playingAudioId.value = null
    currentAudio = null
  })

  currentAudio.addEventListener('error', () => {
    playingAudioId.value = null
    currentAudio = null
  })

  currentAudio.play().catch(() => {
    playingAudioId.value = null
    currentAudio = null
  })
}
</script>

<template>
  <div class="chat-messages" ref="containerRef">
    <div v-if="messages.length === 0" class="empty-state">
      <p>对话将在这里显示</p>
      <p>Chat messages will appear here</p>
    </div>
    <div
      v-for="msg in messages"
      :key="msg.id"
      class="message"
      :class="msg.role"
    >
      <div class="message-avatar">
        <span v-if="msg.role === 'user'">U</span>
        <span v-else>AI</span>
      </div>
      <div class="message-bubble">
        <div class="message-content">{{ msg.content }}</div>
        <div class="message-footer">
          <button
            v-if="msg.audioPath"
            class="audio-btn"
            :class="{ playing: playingAudioId === msg.id }"
            @click="playAudio(msg)"
          >
            {{ playingAudioId === msg.id ? '⏹' : '▶' }}
          </button>
          <span class="message-time">{{ formatTime(msg.timestamp) }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  font-size: 13px;
  gap: 4px;
}

.message {
  display: flex;
  gap: 8px;
  max-width: 80%;
}

.message.user {
  align-self: flex-end;
  flex-direction: row-reverse;
}

.message.assistant {
  align-self: flex-start;
}

.message-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 600;
  flex-shrink: 0;
}

.user .message-avatar {
  background: var(--primary-color);
  color: white;
}

.assistant .message-avatar {
  background: var(--success-color);
  color: white;
}

.message-bubble {
  padding: 8px 12px;
  border-radius: 12px;
  max-width: 100%;
}

.user .message-bubble {
  background: var(--primary-color);
  color: white;
  border-bottom-right-radius: 4px;
}

.assistant .message-bubble {
  background: var(--bg-secondary);
  color: var(--text-primary);
  border: 1px solid var(--border-color);
  border-bottom-left-radius: 4px;
}

.message-content {
  font-size: 13px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.message-footer {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
}

.message-time {
  font-size: 10px;
  opacity: 0.6;
}

.user .message-footer {
  justify-content: flex-end;
}

.audio-btn {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 1px solid rgba(128, 128, 128, 0.3);
  background: transparent;
  cursor: pointer;
  font-size: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  color: inherit;
  opacity: 0.7;
}

.audio-btn:hover {
  opacity: 1;
  background: rgba(128, 128, 128, 0.1);
}

.audio-btn.playing {
  opacity: 1;
  border-color: var(--primary-color);
  color: var(--primary-color);
}
</style>
