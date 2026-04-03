<template>
  <div class="shortcut-scripts">
    <div class="toolbar">
      <button class="btn-primary" @click="startCreate">+ 新建快捷键脚本</button>
    </div>

    <div class="shortcuts-table">
      <div class="table-header">
        <span style="width:100px">快捷键</span>
        <span style="flex:1">名称</span>
        <span style="flex:2">内容预览</span>
        <span style="width:80px">状态</span>
        <span style="width:120px">操作</span>
      </div>

      <div v-for="s in shortcuts" :key="s.id" class="table-row">
        <span class="hotkey-badge" style="width:100px">{{ s.hotkey || '无' }}</span>
        <span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">{{ s.name }}</span>
        <span style="flex:2; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#888">{{ s.content }}</span>
        <span style="width:80px">
          <span :class="s.enabled ? 'badge-on' : 'badge-off'">{{ s.enabled ? '启用' : '停用' }}</span>
        </span>
        <span style="width:120px; display:flex; gap:6px">
          <button class="action-btn" @click="startEdit(s)">编辑</button>
          <button class="action-btn danger" @click="handleDelete(s)">删除</button>
        </span>
      </div>

      <div v-if="shortcuts.length === 0" class="empty">暂无快捷键脚本</div>
    </div>

    <!-- Edit dialog -->
    <div v-if="editing" class="dialog-mask" @click.self="editing = false">
      <div class="dialog">
        <div class="dialog-title">{{ form.id ? '编辑' : '新建' }}快捷键脚本</div>
        <div class="dialog-body">
          <div class="field">
            <label>名称</label>
            <input v-model="form.name" placeholder="脚本名称" />
          </div>
          <div class="field">
            <label>快捷键</label>
            <select v-model="form.hotkey">
              <option value="">不设置</option>
              <option v-for="k in HOTKEYS" :key="k" :value="k">{{ k }}</option>
            </select>
          </div>
          <div class="field">
            <label>脚本内容</label>
            <textarea v-model="form.content" class="content-ta" placeholder="快捷键触发后朗读的内容..." rows="5" />
          </div>
          <div class="field">
            <label>
              <input type="checkbox" v-model="formEnabled" style="margin-right:6px" />启用
            </label>
          </div>
        </div>
        <div class="dialog-footer">
          <button class="btn-ghost" @click="editing = false">取消</button>
          <button class="btn-primary" @click="handleSave">保存</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'

const props = defineProps<{ roomId: string }>()

const HOTKEYS = ['F1','F2','F3','F4','F5','F6','F7','F8','F9','F10','F11','F12']
const shortcuts = ref<any[]>([])
const editing = ref(false)
const form = ref({ id: '', name: '', content: '', hotkey: '', enabled: 1 })
const formEnabled = computed({
  get: () => form.value.enabled === 1,
  set: (v: boolean) => { form.value.enabled = v ? 1 : 0 }
})

async function load(): Promise<void> {
  shortcuts.value = (await window.api.scriptListShortcuts(props.roomId)) || []
}

function startCreate(): void {
  form.value = { id: '', name: '', content: '', hotkey: '', enabled: 1 }
  editing.value = true
}

function startEdit(s: any): void {
  form.value = { id: s.id, name: s.name, content: s.content, hotkey: s.hotkey || '', enabled: s.enabled }
  editing.value = true
}

async function handleSave(): Promise<void> {
  if (!form.value.name.trim() || !form.value.content.trim()) {
    alert('请填写名称和内容')
    return
  }
  try {
    await window.api.scriptSaveShortcut(props.roomId, { ...form.value })
    editing.value = false
    await load()
  } catch (err: any) {
    alert('保存失败：' + (err?.message || err))
  }
}

async function handleDelete(s: any): Promise<void> {
  if (!confirm(`确认删除「${s.name}」？`)) return
  await window.api.scriptDeleteShortcut(s.id)
  await load()
}

onMounted(load)
</script>

<style scoped>
.shortcut-scripts {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 20px;
  gap: 16px;
  overflow: hidden;
  background: #ffffff;
}

.toolbar { display: flex; }

.shortcuts-table {
  flex: 1;
  overflow-y: auto;
  border: 1px solid #e4e4e7;
  border-radius: 8px;
}

.table-header, .table-row {
  display: flex;
  align-items: center;
  padding: 10px 16px;
  gap: 12px;
  font-size: 13px;
}

.table-header {
  background: #f8f8fa;
  color: #71717a;
  border-bottom: 1px solid #e4e4e7;
  font-size: 12px;
  position: sticky;
  top: 0;
}

.table-row {
  color: #18181b;
  border-bottom: 1px solid #f0f0f2;
  transition: background 0.15s;
}
.table-row:hover { background: #f9f9fb; }

.hotkey-badge {
  display: inline-block;
  background: #f4f4f5;
  border: 1px solid #e4e4e7;
  border-radius: 4px;
  padding: 2px 8px;
  font-size: 12px;
  color: #71717a;
  font-family: monospace;
}

.badge-on { color: #16a34a; background: #dcfce7; border-radius: 4px; padding: 2px 8px; font-size: 11px; }
.badge-off { color: #71717a; background: #f4f4f5; border-radius: 4px; padding: 2px 8px; font-size: 11px; }

.empty { padding: 40px; text-align: center; color: #a1a1aa; }

.action-btn { font-size: 12px; padding: 3px 10px; border: 1px solid #e4e4e7; border-radius: 4px; background: transparent; color: #71717a; cursor: pointer; }
.action-btn:hover { color: #18181b; border-color: #a1a1aa; }
.action-btn.danger:hover { color: #dc2626; border-color: #dc2626; }

/* Dialog */
.dialog-mask { position: fixed; inset: 0; background: rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; z-index: 100; }
.dialog { background: #ffffff; border: 1px solid #e4e4e7; border-radius: 10px; padding: 24px; width: 440px; box-shadow: 0 8px 32px rgba(0,0,0,0.12); }
.dialog-title { font-size: 16px; font-weight: 600; color: #18181b; margin-bottom: 20px; }
.dialog-body { display: flex; flex-direction: column; gap: 14px; }
.dialog-footer { display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px; }

.field label { display: block; font-size: 12px; color: #71717a; margin-bottom: 6px; }
.field input:not([type="checkbox"]),
.field select { width: 100%; padding: 8px 12px; background: #f9f9fb; border: 1px solid #e4e4e7; border-radius: 6px; color: #18181b; font-size: 14px; outline: none; }
.content-ta { width: 100%; padding: 10px 12px; background: #f9f9fb; border: 1px solid #e4e4e7; border-radius: 6px; color: #18181b; font-size: 14px; outline: none; font-family: inherit; resize: vertical; }

.btn-primary { padding: 8px 20px; background: #4a9eff; border: none; border-radius: 6px; color: #fff; font-size: 14px; cursor: pointer; }
.btn-ghost { padding: 8px 16px; background: transparent; border: 1px solid #e4e4e7; border-radius: 6px; color: #71717a; font-size: 14px; cursor: pointer; }
.btn-ghost:hover { color: #18181b; border-color: #a1a1aa; }
</style>
