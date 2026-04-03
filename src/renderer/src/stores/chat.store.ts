import { defineStore } from 'pinia'
import { ref } from 'vue'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
  audioPath?: string
}

export const useChatStore = defineStore('chat', () => {
  const messages = ref<ChatMessage[]>([])
  const llmModel = ref('qwen-flash')
  const systemPrompt = ref('你是一个友好的AI助手。')
  const chatActive = ref(false)
  const vadListening = ref(false)
  const vadStatus = ref<'idle' | 'listening' | 'recognizing' | 'speaking'>('idle')
  const loading = ref(false)

  // ASR config
  const asrEnabled = ref(true)

  // TTS config
  const ttsVoice = ref('jack_cheng')
  const ttsSpeed = ref(1.0)

  function addMessage(message: ChatMessage) {
    messages.value.push(message)
  }

  function clearMessages() {
    messages.value = []
  }

  function setChatActive(active: boolean) {
    chatActive.value = active
    if (!active) {
      vadListening.value = false
      vadStatus.value = 'idle'
    }
  }

  function setVadStatus(status: 'idle' | 'listening' | 'recognizing' | 'speaking') {
    vadStatus.value = status
    vadListening.value = status !== 'idle'
  }

  return {
    messages,
    llmModel,
    systemPrompt,
    chatActive,
    vadListening,
    vadStatus,
    loading,
    asrEnabled,
    ttsVoice,
    ttsSpeed,
    addMessage,
    clearMessages,
    setChatActive,
    setVadStatus
  }
})
