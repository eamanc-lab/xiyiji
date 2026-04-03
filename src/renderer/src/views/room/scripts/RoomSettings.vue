<template>
  <div class="room-settings">
    <div class="section">
      <div class="section-header">
        <span class="section-title">AI 模式</span>
      </div>
      <div class="mode-cards">
        <div
          class="mode-card"
          :class="{ active: aiMode === 'full_ai' }"
          @click="setMode('full_ai')"
        >
          <div class="mode-label">全 AI</div>
          <div class="mode-desc">AI 全程生成主线话术并自动响应互动，适合完全托管。</div>
        </div>
        <div
          class="mode-card"
          :class="{ active: aiMode === 'semi_ai' }"
          @click="setMode('semi_ai')"
        >
          <div class="mode-label">半 AI</div>
          <div class="mode-desc">空场按原文循环，弹幕和互动继续由 AI 回复，兼顾稳定和灵活。</div>
        </div>
        <div
          class="mode-card"
          :class="{ active: aiMode === 'no_ai' }"
          @click="setMode('no_ai')"
        >
          <div class="mode-label">无 AI 主线</div>
          <div class="mode-desc">空场只循环原文，不主动写新稿，但仍保留 AI 弹幕互动回复。</div>
        </div>
        <div
          class="mode-card"
          :class="{ active: aiMode === 'ordered_generalize_ai' }"
          @click="setMode('ordered_generalize_ai')"
        >
          <div class="mode-label">顺序泛化AI</div>
          <div class="mode-desc">主线严格按脚本顺序做强约束泛化，互动插入后再回到下一条继续。</div>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-header">
        <span class="section-title">输出语言</span>
      </div>
      <p class="hint">数字人的话术和语音将使用此语言输出。脚本仍可以用中文编写，系统会自动翻译。</p>
      <div class="mode-cards language-cards">
        <div
          class="mode-card"
          :class="{ active: outputLanguage === 'zh-CN' }"
          @click="setLanguage('zh-CN')"
        >
          <div class="mode-label">中文</div>
          <div class="mode-desc">默认模式，直接输出中文话术和中文语音。</div>
        </div>
        <div
          class="mode-card"
          :class="{ active: outputLanguage === 'en' }"
          @click="setLanguage('en')"
        >
          <div class="mode-label">English</div>
          <div class="mode-desc">中文脚本自动转换为英语输出，队列中会保留中文对照。</div>
        </div>
        <div
          class="mode-card"
          :class="{ active: outputLanguage === 'es' }"
          @click="setLanguage('es')"
        >
          <div class="mode-label">Español</div>
          <div class="mode-desc">中文脚本自动转换为西班牙语输出，适合跨语种直播。</div>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-header">
        <span class="section-title">AI 话术提示词</span>
        <button class="btn-save" :disabled="savingPrompt" @click="savePrompt">
          {{ savingPrompt ? '保存中...' : '保存' }}
        </button>
      </div>
      <p class="hint">AI 在生成话术时会遵循此提示词，例如品牌调性、禁聊话题、回复风格等。</p>
      <textarea
        v-model="aiSystemPrompt"
        class="prompt-textarea"
        placeholder="例如：你是一名专业带货主播，语气热情、真诚、利落。禁止提及竞品，不要夸大承诺。"
      />
    </div>

    <div class="section">
      <div class="section-header">
        <span class="section-title">违禁词</span>
        <div class="add-row">
          <input v-model="newWord" placeholder="添加违禁词" maxlength="30" @keyup.enter="addForbidden" />
          <button class="btn-add" @click="addForbidden">添加</button>
        </div>
      </div>
      <p class="hint">包含违禁词的弹幕会被自动过滤，不会进入自动互动回复链路。</p>
      <div class="tag-list">
        <span
          v-for="fw in forbiddenWords"
          :key="fw.id"
          class="tag"
        >
          {{ fw.word }}
          <button class="tag-del" @click="deleteForbidden(fw.id)">×</button>
        </span>
        <span v-if="forbiddenWords.length === 0" class="empty-tags">暂无违禁词</span>
      </div>
    </div>

    <div class="section">
      <div class="section-header">
        <span class="section-title">用户黑名单</span>
        <div class="add-row">
          <input v-model="newUserId" placeholder="平台用户 ID" @keyup.enter="addBlacklist" />
          <button class="btn-add" @click="addBlacklist">添加</button>
        </div>
      </div>
      <p class="hint">黑名单用户的弹幕不会被处理，也不会进入自动互动。</p>
      <div class="blacklist-table">
        <div v-for="bl in blacklist" :key="bl.id" class="bl-row">
          <span class="bl-id">{{ bl.platform_user_id }}</span>
          <span class="bl-note">{{ bl.note }}</span>
          <button class="action-btn danger" @click="deleteBlacklist(bl.id)">删除</button>
        </div>
        <div v-if="blacklist.length === 0" class="empty-tags">暂无黑名单</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'

type AiMode = 'full_ai' | 'semi_ai' | 'no_ai' | 'ordered_generalize_ai'

const props = defineProps<{ roomId: string }>()

const aiMode = ref<AiMode>('full_ai')
const outputLanguage = ref<string>('zh-CN')
const aiSystemPrompt = ref('')
const forbiddenWords = ref<any[]>([])
const blacklist = ref<any[]>([])
const newWord = ref('')
const newUserId = ref('')
const savingPrompt = ref(false)

function normalizeAiMode(value: unknown): AiMode {
  return value === 'semi_ai' ||
    value === 'no_ai' ||
    value === 'ordered_generalize_ai'
    ? value
    : 'full_ai'
}

function normalizeOutputLanguage(value: unknown): string {
  return value === 'en' || value === 'es' ? value : 'zh-CN'
}

async function load(): Promise<void> {
  const settings = await window.api.scriptGetSettings(props.roomId)
  aiMode.value = normalizeAiMode(settings?.ai_mode)
  outputLanguage.value = normalizeOutputLanguage(settings?.output_language)
  aiSystemPrompt.value = settings?.ai_system_prompt || ''
  forbiddenWords.value = (await window.api.scriptListForbidden(props.roomId)) || []
  blacklist.value = (await window.api.scriptListBlacklist(props.roomId)) || []
}

async function setMode(mode: AiMode): Promise<void> {
  aiMode.value = mode
  await window.api.scriptSaveSettings(props.roomId, { aiMode: mode })
}

async function setLanguage(lang: string): Promise<void> {
  outputLanguage.value = lang
  await window.api.scriptSaveSettings(props.roomId, { outputLanguage: lang })
}

async function savePrompt(): Promise<void> {
  savingPrompt.value = true
  try {
    await window.api.scriptSaveSettings(props.roomId, { aiSystemPrompt: aiSystemPrompt.value })
  } finally {
    savingPrompt.value = false
  }
}

async function addForbidden(): Promise<void> {
  const word = newWord.value.trim()
  if (!word) return
  await window.api.scriptAddForbidden(props.roomId, word)
  newWord.value = ''
  forbiddenWords.value = (await window.api.scriptListForbidden(props.roomId)) || []
}

async function deleteForbidden(id: string): Promise<void> {
  await window.api.scriptDeleteForbidden(id)
  forbiddenWords.value = forbiddenWords.value.filter((word) => word.id !== id)
}

async function addBlacklist(): Promise<void> {
  const uid = newUserId.value.trim()
  if (!uid) return
  await window.api.scriptAddBlacklist(props.roomId, { platformUserId: uid })
  newUserId.value = ''
  blacklist.value = (await window.api.scriptListBlacklist(props.roomId)) || []
}

async function deleteBlacklist(id: string): Promise<void> {
  await window.api.scriptDeleteBlacklist(id)
  blacklist.value = blacklist.value.filter((item) => item.id !== id)
}

onMounted(load)
</script>

<style scoped>
.room-settings {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 20px;
  gap: 0;
  overflow-y: auto;
  background: #ffffff;
}

.section {
  border-bottom: 1px solid #f0f0f2;
  padding-bottom: 20px;
  margin-bottom: 20px;
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
  gap: 12px;
}

.section-title {
  font-size: 14px;
  font-weight: 600;
  color: #18181b;
}

.hint {
  font-size: 12px;
  color: #71717a;
  margin-bottom: 12px;
  line-height: 1.5;
}

.prompt-textarea {
  width: 100%;
  height: 120px;
  padding: 12px;
  background: #f9f9fb;
  border: 1px solid #e4e4e7;
  border-radius: 8px;
  color: #18181b;
  font-size: 13px;
  line-height: 1.6;
  resize: vertical;
  outline: none;
  font-family: inherit;
}

.prompt-textarea:focus {
  border-color: #4a9eff;
}

.add-row {
  display: flex;
  gap: 8px;
}

.add-row input {
  padding: 6px 10px;
  background: #f9f9fb;
  border: 1px solid #e4e4e7;
  border-radius: 6px;
  color: #18181b;
  font-size: 13px;
  outline: none;
  width: 220px;
}

.add-row input:focus {
  border-color: #4a9eff;
}

.btn-add {
  padding: 6px 14px;
  background: #f4f4f5;
  border: 1px solid #e4e4e7;
  border-radius: 6px;
  color: #71717a;
  font-size: 13px;
  cursor: pointer;
}

.btn-add:hover {
  background: #e4e4e7;
  color: #18181b;
}

.tag-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.tag {
  display: flex;
  align-items: center;
  gap: 4px;
  background: #f4f4f5;
  border: 1px solid #e4e4e7;
  border-radius: 4px;
  padding: 4px 10px;
  font-size: 12px;
  color: #18181b;
}

.tag-del {
  background: transparent;
  border: none;
  color: #a1a1aa;
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  padding: 0;
}

.tag-del:hover {
  color: #dc2626;
}

.empty-tags {
  color: #a1a1aa;
  font-size: 12px;
}

.blacklist-table {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.bl-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 0;
  border-bottom: 1px solid #f0f0f2;
  font-size: 13px;
}

.bl-id {
  color: #18181b;
  font-family: monospace;
  min-width: 160px;
}

.bl-note {
  color: #71717a;
  flex: 1;
}

.action-btn {
  font-size: 12px;
  padding: 3px 10px;
  border: 1px solid #e4e4e7;
  border-radius: 4px;
  background: transparent;
  color: #71717a;
  cursor: pointer;
}

.action-btn.danger:hover {
  color: #dc2626;
  border-color: #dc2626;
}

.btn-save {
  padding: 6px 16px;
  background: #4a9eff;
  border: none;
  border-radius: 6px;
  color: #fff;
  font-size: 13px;
  cursor: pointer;
}

.btn-save:hover:not(:disabled) {
  background: #3a8ef0;
}

.btn-save:disabled {
  opacity: 0.6;
}

.mode-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
  margin-top: 4px;
}

.language-cards {
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
}

.mode-card {
  border: 2px solid #e4e4e7;
  border-radius: 10px;
  padding: 14px;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
  background: #fafafa;
  text-align: left;
  user-select: none;
}

.mode-card:hover {
  border-color: #a1c4fd;
  background: #f5f9ff;
}

.mode-card.active {
  border-color: #4a9eff;
  background: #eff6ff;
}

.mode-label {
  font-size: 14px;
  font-weight: 600;
  color: #18181b;
  margin-bottom: 6px;
}

.mode-card.active .mode-label {
  color: #2563eb;
}

.mode-desc {
  font-size: 11px;
  color: #71717a;
  line-height: 1.5;
}

.mode-card.active .mode-desc {
  color: #3b82f6;
}
</style>
