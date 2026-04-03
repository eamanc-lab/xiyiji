<template>
  <div class="shortcut-bar">
    <div class="section-header">快捷触发</div>

    <div
      v-for="sc in enabledShortcuts"
      :key="sc.id"
      class="shortcut-item"
      :class="{ triggering: triggeringId === sc.id }"
      @click="handleTrigger(sc)"
    >
      <span v-if="sc.hotkey" class="hotkey-badge">{{ sc.hotkey }}</span>
      <span class="sc-name">{{ sc.name }}</span>
    </div>

    <div v-if="enabledShortcuts.length === 0" class="empty">未配置快捷键脚本</div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useLiveStore } from '../../stores/live.store'

const props = defineProps<{ roomId: string }>()
const liveStore = useLiveStore()
const shortcuts = ref<any[]>([])
const triggeringId = ref<string | null>(null)

const enabledShortcuts = computed(() =>
  shortcuts.value.filter((s) => s.enabled === 1)
)

async function load(): Promise<void> {
  shortcuts.value = (await window.api.scriptListShortcuts(props.roomId)) || []
}

async function handleTrigger(sc: any): Promise<void> {
  if (triggeringId.value) return
  triggeringId.value = sc.id
  try {
    await liveStore.triggerShortcut(sc.id)
  } finally {
    setTimeout(() => { triggeringId.value = null }, 800)
  }
}

function handleKeydown(e: KeyboardEvent): void {
  // Only handle F1-F12 keys, ignore when focused on input/textarea
  const tag = (e.target as HTMLElement)?.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA') return
  if (!e.key.match(/^F([1-9]|1[0-2])$/)) return
  if (liveStore.status !== 'running') return

  const sc = enabledShortcuts.value.find((s) => s.hotkey === e.key)
  if (!sc) return
  e.preventDefault()
  handleTrigger(sc)
}

onMounted(() => {
  load()
  window.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown)
})
</script>

<style scoped>
.shortcut-bar {
  display: flex;
  flex-direction: column;
}

.section-header {
  padding: 8px 12px;
  font-size: 11px;
  font-weight: 600;
  color: #71717a;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  border-bottom: 1px solid #e4e4e7;
}

.shortcut-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  cursor: pointer;
  border-bottom: 1px solid #f0f0f2;
  transition: background 0.15s;
}
.shortcut-item:hover { background: #f4f4f6; }
.shortcut-item.triggering {
  background: #f0fdf4;
  pointer-events: none;
}

.hotkey-badge {
  font-size: 10px;
  padding: 1px 6px;
  background: #f4f4f5;
  border: 1px solid #e4e4e7;
  border-radius: 3px;
  color: #71717a;
  font-family: monospace;
  flex-shrink: 0;
}

.shortcut-item.triggering .hotkey-badge {
  background: #dcfce7;
  border-color: #16a34a;
  color: #16a34a;
}

.sc-name {
  font-size: 12px;
  color: #18181b;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}

.shortcut-item.triggering .sc-name { color: #16a34a; }

.empty {
  padding: 16px 12px;
  font-size: 11px;
  color: #a1a1aa;
  text-align: center;
}
</style>
