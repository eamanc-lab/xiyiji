<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useChatStore } from '@/stores/chat.store'

const { t } = useI18n()
const chatStore = useChatStore()
const ttsVoices = ref<{ id: string; name: string }[]>([])

onMounted(async () => {
  try {
    const result = await window.api.ttsVoices()
    if (result.voices) {
      ttsVoices.value = result.voices
    }
  } catch {
    ttsVoices.value = [
      { id: 'sales_voice', name: '销售之声 - 男声·推荐直播' },
      { id: 'jack_cheng', name: '程杰 - 男声·成熟稳重' },
      { id: 'crystla_liu', name: '晶晶 - 女声·温柔甜美' },
      { id: 'stephen_chow', name: '星爷风 - 男声·幽默' },
      { id: 'xiaoyueyue', name: '小岳岳风 - 男声·亲和' },
      { id: 'entertain', name: '娱乐 - 综艺风格' },
      { id: 'novel', name: '小说 - 有声书风格' },
      { id: 'movie', name: '电影 - 影视解说风格' },
      { id: 'mkas', name: 'MKAS - 特色音色' }
    ]
  }
})
</script>

<template>
  <div class="groupbox">
    <div class="groupbox-title">{{ t('digitalChat.voiceConfig') }}</div>
    <div class="groupbox-content">
      <div class="config-row">
        <label class="checkbox-label">
          <input type="checkbox" v-model="chatStore.asrEnabled" />
          {{ t('digitalChat.asrEnabled') }}
        </label>
      </div>
      <div class="config-row">
        <label>{{ t('digitalChat.ttsVoice') }}</label>
        <select v-model="chatStore.ttsVoice" class="config-select">
          <option v-for="voice in ttsVoices" :key="voice.id" :value="voice.id">
            {{ voice.name }}
          </option>
        </select>
      </div>
      <div class="config-row">
        <label>{{ t('digitalChat.ttsSpeed') }}</label>
        <input type="range" min="0.5" max="2.0" step="0.1" v-model.number="chatStore.ttsSpeed" class="config-range" />
        <span class="range-val">{{ chatStore.ttsSpeed.toFixed(1) }}</span>
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

.config-row label {
  min-width: 70px;
  flex-shrink: 0;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
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

.config-range {
  flex: 1;
}

.range-val {
  min-width: 30px;
  text-align: right;
  font-size: 12px;
  color: var(--text-muted);
}
</style>
