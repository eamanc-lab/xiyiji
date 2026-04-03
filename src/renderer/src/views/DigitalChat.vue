<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useDanmakuStore, type DanmakuMsg } from '@/stores/danmaku.store'

const { t } = useI18n()
const store = useDanmakuStore()
const roomIdInput = ref('')
const messagesContainer = ref<HTMLDivElement | null>(null)
const ttsVoices = ref<{ id: string; name: string }[]>([])

onMounted(async () => {
  store.initListeners()
  await loadTtsVoices()
})

onUnmounted(() => {
  store.destroyListeners()
})

// Auto scroll to bottom when new messages arrive
watch(
  () => store.messages.length,
  () => {
    nextTick(() => {
      if (messagesContainer.value) {
        messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight
      }
    })
  }
)

async function loadTtsVoices() {
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
}

async function toggleConnect() {
  if (store.connected) {
    await window.api.danmakuDisconnect()
    return
  }

  const rid = parseInt(roomIdInput.value)
  if (!rid || rid <= 0) return

  store.connecting = true
  store.error = null
  try {
    const result = await window.api.danmakuConnect(rid)
    if (!result.success) {
      store.error = result.error || '连接失败'
      store.connecting = false
    }
  } catch (err: any) {
    store.error = err.message
    store.connecting = false
  }
}

async function toggleAutoReply() {
  const newVal = !store.autoReplyEnabled
  store.autoReplyEnabled = newVal
  await window.api.danmakuSetAutoReply(newVal)
}

async function updateSystemPrompt() {
  await window.api.danmakuSetSystemPrompt(store.systemPrompt)
}

async function updateTtsVoice() {
  await window.api.danmakuSetTtsVoice(store.ttsVoice)
}

async function updateTtsSpeed() {
  await window.api.danmakuSetTtsSpeed(store.ttsSpeed)
}

async function updateCooldown() {
  await window.api.danmakuSetCooldown(store.cooldown * 1000)
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`
}
</script>

<template>
  <div class="digital-chat-page">
    <div class="page-header">
      <h2>{{ t('digitalChat.title') }}</h2>
    </div>
    <div class="page-body">
      <!-- Left: config panel -->
      <div class="left-column">
        <!-- Connection panel -->
        <div class="groupbox">
          <div class="groupbox-title">弹幕连接</div>
          <div class="groupbox-content">
            <div class="form-row">
              <label>平台</label>
              <select v-model="store.platform" class="form-select" disabled>
                <option value="bilibili">Bilibili</option>
                <option value="douyin">抖音 (即将支持)</option>
              </select>
            </div>
            <div class="form-row">
              <label>房间号</label>
              <input
                v-model="roomIdInput"
                type="text"
                class="form-input"
                placeholder="输入直播间房间号"
                :disabled="store.connected"
                @keyup.enter="toggleConnect"
              />
            </div>
            <div class="form-row">
              <button
                class="form-btn"
                :class="store.connected ? 'btn-danger' : 'btn-primary'"
                @click="toggleConnect"
                :disabled="store.connecting || (!store.connected && !roomIdInput)"
              >
                {{ store.connecting ? '连接中...' : store.connected ? '断开连接' : '连接' }}
              </button>
            </div>
            <div class="connection-status" v-if="store.connected">
              <span class="status-connected">已连接</span>
              <span class="popularity">在线: {{ store.popularity }}</span>
            </div>
            <div class="error-text" v-if="store.error">{{ store.error }}</div>
          </div>
        </div>

        <!-- Auto-reply config -->
        <div class="groupbox">
          <div class="groupbox-title">自动回复配置</div>
          <div class="groupbox-content">
            <div class="form-row">
              <label class="checkbox-label">
                <input type="checkbox" :checked="store.autoReplyEnabled" @change="toggleAutoReply" />
                启用自动回复
              </label>
            </div>
            <div class="form-row vertical">
              <label>主播人设 (系统提示词)</label>
              <textarea
                v-model="store.systemPrompt"
                class="form-textarea"
                rows="3"
                @blur="updateSystemPrompt"
                placeholder="设定数字人主播的人设和回复风格..."
              ></textarea>
            </div>
            <div class="form-row">
              <label>音色</label>
              <select v-model="store.ttsVoice" class="form-select" @change="updateTtsVoice">
                <option v-for="voice in ttsVoices" :key="voice.id" :value="voice.id">
                  {{ voice.name }}
                </option>
              </select>
            </div>
            <div class="form-row">
              <label>语速</label>
              <input type="range" min="0.5" max="2.0" step="0.1" v-model.number="store.ttsSpeed" class="form-range" @change="updateTtsSpeed" />
              <span class="range-val">{{ store.ttsSpeed.toFixed(1) }}</span>
            </div>
            <div class="form-row">
              <label>冷却(秒)</label>
              <input type="range" min="1" max="30" step="1" v-model.number="store.cooldown" class="form-range" @change="updateCooldown" />
              <span class="range-val">{{ store.cooldown }}s</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Right: message flow -->
      <div class="right-column">
        <div class="groupbox messages-box">
          <div class="groupbox-title">
            弹幕消息
            <button class="clear-btn" @click="store.clearMessages" v-if="store.messages.length > 0">清空</button>
          </div>
          <div class="messages-container" ref="messagesContainer">
            <div v-if="store.messages.length === 0" class="empty-messages">
              <p v-if="!store.connected">连接直播间后，弹幕将显示在此处</p>
              <p v-else>等待弹幕中...</p>
            </div>
            <div
              v-for="(msg, i) in store.messages"
              :key="i"
              class="message-item"
              :class="'msg-' + msg.type"
            >
              <span class="msg-time">{{ formatTime(msg.timestamp) }}</span>
              <template v-if="msg.type === 'danmaku'">
                <span class="msg-user">{{ msg.username }}</span>
                <span class="msg-text">{{ msg.text }}</span>
              </template>
              <template v-else-if="msg.type === 'reply'">
                <span class="msg-user msg-ai">AI</span>
                <span class="msg-text msg-reply-text">{{ msg.text }}</span>
              </template>
              <template v-else>
                <span class="msg-system">{{ msg.text }}</span>
              </template>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.digital-chat-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  gap: 12px;
}

.page-header h2 {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
}

.page-body {
  display: flex;
  flex: 1;
  gap: 12px;
  min-height: 0;
}

.left-column {
  width: 320px;
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

/* Form controls */
.form-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 8px;
}

.form-row:last-child { margin-bottom: 0; }

.form-row.vertical {
  flex-direction: column;
  align-items: stretch;
}

.form-row label {
  min-width: 70px;
  flex-shrink: 0;
}

.form-select, .form-input {
  flex: 1;
  padding: 6px 8px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-size: 13px;
}

.form-range { flex: 1; }

.range-val {
  min-width: 30px;
  text-align: right;
  font-size: 12px;
  color: var(--text-muted);
}

.form-btn {
  padding: 6px 14px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background: var(--bg-card);
  color: var(--text-primary);
  font-size: 13px;
  cursor: pointer;
  width: 100%;
}

.form-btn.btn-primary {
  background: var(--primary-color);
  color: white;
  border-color: var(--primary-color);
}

.form-btn.btn-danger {
  background: #D54941;
  color: white;
  border-color: #D54941;
}

.form-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.form-textarea {
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

.form-textarea:focus {
  border-color: var(--primary-color);
  outline: none;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}

.connection-status {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 12px;
  margin-top: 4px;
}

.status-connected {
  color: var(--success-color);
  font-weight: 500;
}

.popularity {
  color: var(--text-muted);
}

.error-text {
  color: #D54941;
  font-size: 12px;
  margin-top: 4px;
}

/* Messages */
.messages-box {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.messages-box .groupbox-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.clear-btn {
  font-size: 11px;
  padding: 2px 8px;
  border: 1px solid var(--border-light);
  border-radius: 3px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}

.clear-btn:hover {
  border-color: var(--border-color);
  color: var(--text-secondary);
}

.messages-container {
  flex: 1;
  overflow-y: auto;
  padding: 8px 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.empty-messages {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  font-size: 13px;
}

.message-item {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 13px;
  line-height: 1.4;
  padding: 3px 0;
}

.msg-time {
  color: var(--text-muted);
  font-size: 11px;
  min-width: 55px;
  flex-shrink: 0;
  font-family: monospace;
  margin-top: 1px;
}

.msg-user {
  color: #0052D9;
  font-weight: 500;
  flex-shrink: 0;
  max-width: 80px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.msg-user.msg-ai {
  color: #2BA471;
}

.msg-text {
  color: var(--text-primary);
  word-break: break-all;
}

.msg-reply-text {
  color: #2BA471;
}

.msg-system {
  color: var(--text-muted);
  font-style: italic;
  font-size: 12px;
}
</style>
