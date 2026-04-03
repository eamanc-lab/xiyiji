<template>
  <div class="tab-danmaku">
    <!-- Left panel -->
    <div class="danmaku-sidebar">
      <!-- Connection Panel -->
      <div class="sidebar-section">
        <div class="section-title">平台连接</div>

        <div class="field">
          <label>平台</label>
          <select
            v-model="danmakuStore.platform"
            :disabled="danmakuStore.connected || danmakuStore.connecting"
          >
            <option value="bilibili">Bilibili</option>
            <option value="tiktok">TikTok</option>
            <option value="douyin">抖音</option>
            <option value="weixin_channel">视频号</option>
            <option value="taobao">淘宝直播</option>
            <option value="xiaohongshu">小红书</option>
          </select>
        </div>

        <div v-if="!noInputPlatforms.includes(danmakuStore.platform)" class="field">
          <label>{{ inputLabel }}</label>
          <input
            v-model="inputValue"
            :placeholder="inputPlaceholder"
            :disabled="danmakuStore.connected || danmakuStore.connecting"
            @keyup.enter="handleConnect"
          />
        </div>
        <div v-else class="field">
          <label>{{ inputLabel }}</label>
          <span class="field-hint">{{ inputPlaceholder }}</span>
        </div>

        <div class="connect-row">
          <button
            v-if="!danmakuStore.connected"
            class="btn btn-primary"
            :disabled="connectDisabled"
            @click="handleConnect"
          >
            {{ danmakuStore.connecting ? '连接中...' : '连接' }}
          </button>
          <button
            v-else
            class="btn btn-danger"
            @click="handleDisconnect"
          >断开</button>

          <div class="status-indicator">
            <span
              class="status-dot"
              :class="{
                'dot-connected': danmakuStore.connected,
                'dot-connecting': danmakuStore.connecting,
                'dot-error': danmakuStore.error
              }"
            />
            <span class="status-text">
              {{ danmakuStore.connected ? '已连接' : danmakuStore.connecting ? '连接中' : danmakuStore.error ? '错误' : '未连接' }}
            </span>
          </div>
        </div>

        <div v-if="danmakuStore.connected && danmakuStore.platform === 'bilibili'" class="popularity">
          人气: {{ danmakuStore.popularity.toLocaleString() }}
        </div>

        <div v-if="danmakuStore.error" class="error-msg">{{ danmakuStore.error }}</div>
      </div>

      <!-- Auto-Reply Settings -->
      <div class="sidebar-section">
        <div class="section-title">自动回复</div>

        <div class="field-row">
          <label>启用</label>
          <label class="toggle">
            <input
              type="checkbox"
              :checked="danmakuStore.autoReplyEnabled"
              @change="toggleAutoReply"
            />
            <span class="toggle-slider" />
          </label>
        </div>

        <div class="field">
          <label>冷却 (秒)</label>
          <input
            type="number"
            :value="danmakuStore.cooldown"
            min="1"
            max="60"
            @change="updateCooldown"
          />
        </div>

      </div>

      <!-- Filter Settings -->
      <div class="sidebar-section">
        <div class="section-title">过滤规则</div>

        <div class="field">
          <label>禁词 (一行一个)</label>
          <textarea
            v-model="forbiddenText"
            rows="3"
            placeholder="每行一个禁词"
            @blur="saveForbiddenWords"
          />
        </div>

        <div class="field">
          <label>黑名单 UID (一行一个)</label>
          <textarea
            v-model="blacklistText"
            rows="2"
            placeholder="每行一个用户ID"
            @blur="saveBlacklist"
          />
        </div>

        <div class="field">
          <label>显示类型</label>
          <div class="checkbox-group">
            <label v-for="(val, key) in danmakuStore.eventTypeFilters" :key="key" class="check-item">
              <input type="checkbox" v-model="danmakuStore.eventTypeFilters[key]" />
              <span>{{ typeLabels[key] || key }}</span>
            </label>
          </div>
        </div>
      </div>
    </div>

    <!-- Main content -->
    <div class="danmaku-main">
      <!-- Message stream -->
      <div ref="streamRef" class="danmaku-stream" @scroll="handleScroll">
        <div
          v-for="(msg, i) in danmakuStore.filteredMessages"
          :key="i"
          class="msg-row"
          :class="`msg-${msg.type}`"
        >
          <span class="msg-time">{{ formatTime(msg.timestamp) }}</span>
          <span class="msg-icon">{{ typeIcon(msg.type) }}</span>
          <span v-if="msg.username" class="msg-user" :class="{ 'user-ai': msg.type === 'reply' }">{{ msg.username }}</span>
          <span class="msg-text">{{ formatMsgText(msg) }}</span>
        </div>

        <div v-if="danmakuStore.filteredMessages.length === 0" class="stream-empty">
          暂无弹幕消息
        </div>
      </div>

      <!-- Stats bar -->
      <div class="stats-bar">
        <span class="stat-item">总计 <b>{{ danmakuStore.stats.total }}</b></span>
        <span class="stat-sep">|</span>
        <span class="stat-item">评论 <b>{{ danmakuStore.stats.comment }}</b></span>
        <span class="stat-sep">|</span>
        <span class="stat-item">礼物 <b>{{ danmakuStore.stats.gift }}</b></span>
        <span class="stat-sep">|</span>
        <span class="stat-item">点赞 <b>{{ danmakuStore.stats.like }}</b></span>
        <span class="stat-sep">|</span>
        <span class="stat-item">关注 <b>{{ danmakuStore.stats.follow }}</b></span>
        <span class="stat-sep">|</span>
        <span class="stat-item">回复 <b>{{ danmakuStore.stats.reply }}</b></span>
        <span class="stat-sep">|</span>
        <span class="stat-item">
          成功率 <b>{{ danmakuStore.stats.reply > 0 ? Math.round(danmakuStore.stats.success / danmakuStore.stats.reply * 100) : 0 }}%</b>
        </span>
        <span class="stat-spacer" />
        <button class="btn-clear" @click="danmakuStore.clearMessages()">清空</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, nextTick, onMounted, onUnmounted, computed } from 'vue'
import { useDanmakuStore } from '../../stores/danmaku.store'

const props = defineProps<{
  roomId: string
}>()

const danmakuStore = useDanmakuStore()
const streamRef = ref<HTMLElement | null>(null)
const autoScroll = ref(true)
const inputValue = ref('')
const forbiddenText = ref('')
const blacklistText = ref('')
const typeLabels: Record<string, string> = {
  danmaku: '评论',
  gift: '礼物',
  follow: '关注',
  enter: '入场',
  like: '点赞',
  share: '分享'
}

/** Platforms that don't require text input to connect */
const noInputPlatforms = ['weixin_channel', 'xiaohongshu']

const inputLabel = computed(() => {
  const map: Record<string, string> = {
    bilibili: '房间号',
    tiktok: 'TikTok 用户名',
    douyin: '直播间 URL',
    weixin_channel: '视频号',
    taobao: '直播间 URL（可选）',
    xiaohongshu: '小红书'
  }
  return map[danmakuStore.platform] || '房间号'
})

const inputPlaceholder = computed(() => {
  const map: Record<string, string> = {
    bilibili: '输入 Bilibili 房间号',
    tiktok: '输入主播用户名 (如 cocoshop)',
    douyin: 'https://live.douyin.com/...',
    weixin_channel: '点击连接后扫码登录',
    taobao: 'https://live.taobao.com/...（留空打开首页）',
    xiaohongshu: '点击连接后在弹出窗口登录'
  }
  return map[danmakuStore.platform] || ''
})

/** Platforms that don't need input text to connect */
const connectDisabled = computed(() => {
  if (noInputPlatforms.includes(danmakuStore.platform) || danmakuStore.platform === 'taobao') {
    return danmakuStore.connecting
  }
  return danmakuStore.connecting || !inputValue.value.trim()
})

// Auto-scroll on new messages
watch(
  () => danmakuStore.filteredMessages.length,
  async () => {
    if (!autoScroll.value) return
    await nextTick()
    if (streamRef.value) {
      streamRef.value.scrollTop = streamRef.value.scrollHeight
    }
  }
)

function handleScroll() {
  if (!streamRef.value) return
  const el = streamRef.value
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60
  autoScroll.value = atBottom
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`
}

function typeIcon(type: string): string {
  const icons: Record<string, string> = {
    danmaku: '\u{1F4AC}',
    gift: '\u{1F381}',
    follow: '\u{2795}',
    enter: '\u{1F44B}',
    like: '\u{2764}\u{FE0F}',
    share: '\u{1F4E4}',
    reply: '\u{1F916}',
    system: '\u{2139}\u{FE0F}'
  }
  return icons[type] || '\u{00B7}'
}

function formatMsgText(msg: any): string {
  if (msg.type === 'gift' && msg.giftName) {
    return `送出 ${msg.giftName}${msg.count && msg.count > 1 ? ' x' + msg.count : ''}`
  }
  if (msg.type === 'follow') return '关注了主播'
  if (msg.type === 'enter') return '进入直播间'
  if (msg.type === 'like') return '点赞'
  if (msg.type === 'share') return '分享了直播间'
  return msg.text || ''
}

async function handleConnect() {
  if (noInputPlatforms.includes(danmakuStore.platform)) {
    await danmakuStore.connect('')
    return
  }
  // Taobao allows empty input (opens home page)
  if (danmakuStore.platform === 'taobao') {
    await danmakuStore.connect(inputValue.value.trim())
    return
  }
  const val = inputValue.value.trim()
  if (!val) return
  await danmakuStore.connect(val)
}

async function handleDisconnect() {
  await danmakuStore.disconnect()
}

async function toggleAutoReply(e: Event) {
  const enabled = (e.target as HTMLInputElement).checked
  danmakuStore.autoReplyEnabled = enabled
  await window.api.danmakuSetAutoReply(enabled)
}

async function updateCooldown(e: Event) {
  const val = Number((e.target as HTMLInputElement).value)
  danmakuStore.cooldown = val
  await window.api.danmakuSetCooldown(val * 1000)
}

async function saveForbiddenWords() {
  const words = forbiddenText.value.split('\n').map(w => w.trim()).filter(Boolean)
  danmakuStore.forbiddenWords = words
  await window.api.danmakuSetForbiddenWords(words)
}

async function saveBlacklist() {
  const ids = blacklistText.value.split('\n').map(w => w.trim()).filter(Boolean)
  danmakuStore.blacklistUsers = ids
  await window.api.danmakuSetBlacklist(ids)
}

onMounted(async () => {
  danmakuStore.initListeners()

  // Load persisted filter settings from room DB
  try {
    const forbidden = await window.api.scriptListForbidden(props.roomId)
    if (Array.isArray(forbidden)) {
      const words = forbidden.map((f: any) => f.word || f.text || '').filter(Boolean)
      forbiddenText.value = words.join('\n')
      danmakuStore.forbiddenWords = words
      await window.api.danmakuSetForbiddenWords(words)
    }

    const blacklist = await window.api.scriptListBlacklist(props.roomId)
    if (Array.isArray(blacklist)) {
      const ids = blacklist.map((b: any) => String(b.user_id || b.userId || '')).filter(Boolean)
      blacklistText.value = ids.join('\n')
      danmakuStore.blacklistUsers = ids
      await window.api.danmakuSetBlacklist(ids)
    }
  } catch { /* ignore if no room data */ }
})

onUnmounted(() => {
  danmakuStore.destroyListeners()
})
</script>

<style scoped>
.tab-danmaku {
  display: flex;
  height: 100%;
  overflow: hidden;
}

/* ── Sidebar ── */
.danmaku-sidebar {
  width: 240px;
  flex-shrink: 0;
  border-right: 1px solid #e4e4e7;
  background: #f8f8fa;
  overflow-y: auto;
  padding-bottom: 16px;
}

.sidebar-section {
  padding: 12px 14px;
  border-bottom: 1px solid #e4e4e7;
}

.section-title {
  font-size: 11px;
  font-weight: 600;
  color: #71717a;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 10px;
}

.field {
  margin-bottom: 8px;
}

.field label {
  display: block;
  font-size: 11px;
  color: #71717a;
  margin-bottom: 3px;
}

.field input,
.field select,
.field textarea {
  width: 100%;
  padding: 5px 8px;
  font-size: 12px;
  border: 1px solid #d4d4d8;
  border-radius: 4px;
  background: #fff;
  color: #18181b;
  outline: none;
  box-sizing: border-box;
}

.field input:focus,
.field select:focus,
.field textarea:focus {
  border-color: #4a9eff;
}

.field textarea {
  resize: vertical;
  font-family: inherit;
}

.field-hint {
  display: block;
  font-size: 12px;
  color: #a1a1aa;
  padding: 5px 0;
}

.field-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.field-row label:first-child {
  font-size: 11px;
  color: #71717a;
}

/* Toggle switch */
.toggle {
  position: relative;
  display: inline-block;
  width: 36px;
  height: 20px;
}

.toggle input { display: none; }

.toggle-slider {
  position: absolute;
  inset: 0;
  background: #d4d4d8;
  border-radius: 10px;
  cursor: pointer;
  transition: background 0.2s;
}

.toggle-slider::before {
  content: '';
  position: absolute;
  width: 16px;
  height: 16px;
  left: 2px;
  top: 2px;
  background: #fff;
  border-radius: 50%;
  transition: transform 0.2s;
}

.toggle input:checked + .toggle-slider {
  background: #4a9eff;
}

.toggle input:checked + .toggle-slider::before {
  transform: translateX(16px);
}

.connect-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.status-indicator {
  display: flex;
  align-items: center;
  gap: 4px;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #a1a1aa;
}

.dot-connected { background: #16a34a; }
.dot-connecting { background: #ca8a04; animation: blink 1s infinite; }
.dot-error { background: #dc2626; }

@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

.status-text {
  font-size: 11px;
  color: #71717a;
}

.popularity {
  font-size: 11px;
  color: #71717a;
  margin-top: 2px;
}

.error-msg {
  font-size: 11px;
  color: #dc2626;
  margin-top: 4px;
  word-break: break-all;
}

.checkbox-group {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
}

.check-item {
  display: flex;
  align-items: center;
  gap: 3px;
  font-size: 11px;
  color: #52525b;
  cursor: pointer;
}

.check-item input[type="checkbox"] {
  width: auto;
  margin: 0;
}

/* ── Buttons ── */
.btn {
  padding: 5px 14px;
  font-size: 12px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  transition: background 0.15s;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-primary {
  background: #4a9eff;
  color: #fff;
}

.btn-primary:hover:not(:disabled) {
  background: #2563eb;
}

.btn-danger {
  background: #dc2626;
  color: #fff;
}

.btn-danger:hover:not(:disabled) {
  background: #b91c1c;
}

/* ── Main content ── */
.danmaku-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: #fff;
}

.danmaku-stream {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}

.msg-row {
  display: flex;
  align-items: baseline;
  gap: 5px;
  padding: 4px 14px;
  font-size: 12px;
  line-height: 1.5;
  border-bottom: 1px solid #f4f4f5;
}

.msg-row:hover {
  background: #f9f9fb;
}

.msg-gift { background: #fffbeb; }
.msg-follow { background: #f0fdf4; }
.msg-enter { background: #eff6ff; }
.msg-like { background: #fef2f2; }
.msg-share { background: #faf5ff; }
.msg-reply { background: #f5f3ff; border-left: 3px solid #7c3aed; }
.msg-system { background: #f4f4f5; font-style: italic; }

.msg-time {
  color: #a1a1aa;
  font-size: 10px;
  font-family: monospace;
  flex-shrink: 0;
}

.msg-icon {
  font-size: 11px;
  flex-shrink: 0;
}

.msg-user {
  color: #3b82f6;
  font-weight: 600;
  flex-shrink: 0;
  max-width: 100px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.user-ai {
  color: #7c3aed;
}

.msg-text {
  color: #18181b;
  word-break: break-all;
  flex: 1;
}

.msg-gift .msg-text { color: #ca8a04; }
.msg-follow .msg-text { color: #16a34a; }
.msg-system .msg-text { color: #71717a; }
.msg-reply .msg-text { color: #6d28d9; }

.stream-empty {
  padding: 60px;
  text-align: center;
  color: #a1a1aa;
  font-size: 14px;
}

/* ── Stats bar ── */
.stats-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  background: #f8f8fa;
  border-top: 1px solid #e4e4e7;
  font-size: 11px;
  color: #71717a;
  flex-shrink: 0;
}

.stat-item b {
  color: #18181b;
  font-weight: 600;
}

.stat-sep {
  color: #d4d4d8;
}

.stat-spacer {
  flex: 1;
}

.btn-clear {
  padding: 2px 10px;
  font-size: 11px;
  border: 1px solid #d4d4d8;
  border-radius: 4px;
  background: #fff;
  color: #71717a;
  cursor: pointer;
}

.btn-clear:hover {
  background: #f4f4f5;
  color: #18181b;
}
</style>
