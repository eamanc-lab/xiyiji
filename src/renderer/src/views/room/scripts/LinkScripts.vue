<template>
  <div class="link-scripts">
    <!-- Slot list (left) -->
    <div class="slot-list">
      <div class="slot-header">链接脚本 (最多10个)</div>
      <div
        v-for="slot in SLOTS"
        :key="slot"
        class="slot-item"
        :class="{ active: activeSlot === slot, filled: slotMap[slot] }"
        @click="selectSlot(slot)"
      >
        <span class="slot-no">{{ slot }}号链接</span>
        <span v-if="slotMap[slot]" class="slot-name">{{ slotMap[slot].name }}</span>
        <span v-else class="slot-empty">（未设置）</span>
      </div>
    </div>

    <!-- Editor (right) -->
    <div class="slot-editor">
      <div class="editor-header">
        <span>{{ activeSlot }}号链接脚本</span>
        <div class="editor-actions">
          <button v-if="slotMap[activeSlot]" class="btn-ghost" @click="handleDelete">删除</button>
          <button class="btn-save" :disabled="saving" @click="handleSave">
            {{ saving ? '保存中...' : '保存' }}
          </button>
        </div>
      </div>

      <div class="field">
        <label>产品名称</label>
        <input v-model="editName" placeholder="如：蜂蜜礼盒装500g" maxlength="50" />
      </div>

      <div class="field flex-1">
        <label>链接脚本内容</label>
        <textarea
          v-model="editContent"
          class="content-textarea"
          placeholder="输入该链接对应的销售话术...

示例：
我们今天主推的这款蜂蜜礼盒，100%纯天然，无添加！500g的量，家庭装超划算。
现在下单立减20元，数量有限，抓紧时间哦！"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, computed } from 'vue'

const props = defineProps<{ roomId: string }>()

const SLOTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
const links = ref<any[]>([])
const activeSlot = ref(1)
const editName = ref('')
const editContent = ref('')
const saving = ref(false)

const slotMap = computed(() => {
  const map: Record<number, any> = {}
  for (const l of links.value) {
    map[l.slot_no] = l
  }
  return map
})

async function load(): Promise<void> {
  links.value = (await window.api.scriptListLinks(props.roomId)) || []
}

function selectSlot(slot: number): void {
  activeSlot.value = slot
  const existing = slotMap.value[slot]
  editName.value = existing?.name || ''
  editContent.value = existing?.content || ''
}

async function handleSave(): Promise<void> {
  saving.value = true
  try {
    await window.api.scriptSaveLink(props.roomId, activeSlot.value, editName.value, editContent.value)
    await load()
  } finally {
    saving.value = false
  }
}

async function handleDelete(): Promise<void> {
  if (!confirm(`确认删除 ${activeSlot.value} 号链接脚本？`)) return
  await window.api.scriptDeleteLink(props.roomId, activeSlot.value)
  editName.value = ''
  editContent.value = ''
  await load()
}

watch(activeSlot, (slot) => {
  const existing = slotMap.value[slot]
  editName.value = existing?.name || ''
  editContent.value = existing?.content || ''
})

onMounted(async () => {
  await load()
  selectSlot(1)
})
</script>

<style scoped>
.link-scripts {
  display: flex;
  height: 100%;
  overflow: hidden;
}

.slot-list {
  width: 180px;
  background: #f8f8fa;
  border-right: 1px solid #e4e4e7;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  overflow-y: auto;
}

.slot-header {
  padding: 12px 14px;
  font-size: 12px;
  color: #71717a;
  border-bottom: 1px solid #e4e4e7;
}

.slot-item {
  padding: 10px 14px;
  cursor: pointer;
  border-bottom: 1px solid #f0f0f2;
  transition: background 0.15s;
}
.slot-item:hover { background: #f0f0f2; }
.slot-item.active { background: #eff6ff; }
.slot-item.filled .slot-no { color: #18181b; }

.slot-no { font-size: 13px; color: #71717a; display: block; }
.slot-name { font-size: 11px; color: #4a9eff; display: block; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.slot-empty { font-size: 11px; color: #a1a1aa; display: block; margin-top: 2px; }

.slot-editor {
  flex: 1;
  display: flex;
  flex-direction: column;
  padding: 20px;
  gap: 14px;
  overflow: hidden;
  background: #ffffff;
}

.editor-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 15px;
  font-weight: 600;
  color: #18181b;
}

.editor-actions { display: flex; gap: 8px; }

.field { display: flex; flex-direction: column; gap: 6px; }
.field.flex-1 { flex: 1; min-height: 0; }
.field label { font-size: 12px; color: #71717a; }
.field input {
  padding: 8px 12px;
  background: #f9f9fb;
  border: 1px solid #e4e4e7;
  border-radius: 6px;
  color: #18181b;
  font-size: 14px;
  outline: none;
}
.field input:focus { border-color: #4a9eff; }

.content-textarea {
  flex: 1;
  padding: 12px;
  background: #f9f9fb;
  border: 1px solid #e4e4e7;
  border-radius: 8px;
  color: #18181b;
  font-size: 14px;
  line-height: 1.7;
  resize: none;
  outline: none;
  font-family: inherit;
}
.content-textarea:focus { border-color: #4a9eff; }

.btn-save { padding: 7px 16px; background: #4a9eff; border: none; border-radius: 6px; color: #fff; font-size: 13px; cursor: pointer; }
.btn-save:hover:not(:disabled) { background: #3a8ef0; }
.btn-save:disabled { opacity: 0.6; }
.btn-ghost { padding: 7px 14px; background: transparent; border: 1px solid #e4e4e7; border-radius: 6px; color: #71717a; font-size: 13px; cursor: pointer; }
.btn-ghost:hover { color: #dc2626; border-color: #dc2626; }
</style>
