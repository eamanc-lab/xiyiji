<template>
  <div class="link-switcher">
    <div class="section-header">链接切换</div>

    <!-- Auto-rotation toggle -->
    <div v-if="links.length >= 2" class="rotation-toggle">
      <label class="rotation-label">
        <input
          type="checkbox"
          :checked="liveStore.autoRotationEnabled"
          @change="toggleRotation"
        />
        <span>AI自动轮播</span>
      </label>
      <select
        v-if="liveStore.autoRotationEnabled"
        class="batches-select"
        :value="batchesPerProduct"
        @change="updateBatches"
      >
        <option :value="1">每商品1轮</option>
        <option :value="2">每商品2轮</option>
        <option :value="3">每商品3轮</option>
      </select>
    </div>

    <div
      v-for="link in links"
      :key="link.id"
      class="link-item"
      :class="{
        active: liveStore.activeLinkId === link.id,
        'rotation-active': liveStore.autoRotationEnabled && liveStore.activeLinkId === link.id
      }"
      @click="handleSwitch(link)"
    >
      <span class="link-no">{{ link.slot_no }}</span>
      <div class="link-info">
        <span class="link-name">{{ link.name || `链接${link.slot_no}` }}</span>
        <span
          v-if="liveStore.autoRotationEnabled && liveStore.activeLinkId === link.id"
          class="rotation-badge"
        >
          <template v-if="liveStore.autoRotationInterrupted">
            弹幕打断 · {{ liveStore.autoRotationInterruptedBy }}
          </template>
          <template v-else>
            {{ liveStore.autoRotationBatchProgress }}/{{ liveStore.autoRotationBatchTotal }}
          </template>
        </span>
      </div>
      <span v-if="liveStore.activeLinkId === link.id" class="active-dot" />
    </div>

    <div
      class="link-item link-item-none"
      :class="{
        active: liveStore.activeLinkId === null && !liveStore.autoRotationEnabled,
        disabled: liveStore.autoRotationEnabled
      }"
      @click="handleSwitchNone"
    >
      <span class="link-no">—</span>
      <span class="link-name">不使用链接脚本</span>
    </div>

    <div v-if="links.length === 0" class="empty">未配置链接脚本</div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useLiveStore } from '../../stores/live.store'

const props = defineProps<{ roomId: string }>()
const liveStore = useLiveStore()
const links = ref<any[]>([])
const batchesPerProduct = ref(1)

async function load(): Promise<void> {
  links.value = (await window.api.scriptListLinks(props.roomId)) || []
  // Default: auto-enable rotation when there are 2+ links
  if (links.value.length >= 2 && !liveStore.autoRotationEnabled) {
    liveStore.enableAutoRotation(batchesPerProduct.value)
  }
}

async function handleSwitch(link: any): Promise<void> {
  // Manual click disables auto-rotation (handled in store.switchLink)
  await liveStore.switchLink(link.id)
}

async function handleSwitchNone(): Promise<void> {
  if (liveStore.autoRotationEnabled) return // disabled when rotation is on
  await liveStore.switchLink(null)
}

function toggleRotation(e: Event): void {
  const checked = (e.target as HTMLInputElement).checked
  if (checked) {
    liveStore.enableAutoRotation(batchesPerProduct.value)
  } else {
    liveStore.disableAutoRotation()
  }
}

function updateBatches(e: Event): void {
  const val = parseInt((e.target as HTMLSelectElement).value, 10)
  batchesPerProduct.value = val
  if (liveStore.autoRotationEnabled) {
    // Re-enable with new value
    liveStore.enableAutoRotation(val)
  }
}

onMounted(load)
</script>

<style scoped>
.link-switcher {
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

/* Auto-rotation toggle */
.rotation-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  border-bottom: 1px solid #e4e4e7;
  background: #fafafa;
}

.rotation-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: #52525b;
  cursor: pointer;
  user-select: none;
}

.rotation-label input[type="checkbox"] {
  margin: 0;
  cursor: pointer;
}

.batches-select {
  font-size: 11px;
  padding: 2px 4px;
  border: 1px solid #d4d4d8;
  border-radius: 4px;
  background: white;
  color: #52525b;
  cursor: pointer;
}

/* Link items */
.link-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  cursor: pointer;
  border-bottom: 1px solid #f0f0f2;
  transition: background 0.15s;
}
.link-item:hover { background: #f4f4f6; }
.link-item.active { background: #eff6ff; }
.link-item.rotation-active { background: #fffbeb; }

.link-item-none { opacity: 0.6; }
.link-item-none:hover { opacity: 1; }
.link-item-none.active { opacity: 1; }
.link-item-none.disabled {
  opacity: 0.3;
  cursor: not-allowed;
  pointer-events: none;
}

.link-no {
  width: 20px;
  height: 20px;
  background: #f4f4f5;
  border: 1px solid #e4e4e7;
  border-radius: 4px;
  font-size: 11px;
  color: #71717a;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  font-family: monospace;
}

.link-item.active .link-no {
  background: #dbeafe;
  border-color: #93c5fd;
  color: #3b82f6;
}

.link-item.rotation-active .link-no {
  background: #fef3c7;
  border-color: #f59e0b;
  color: #d97706;
}

.link-info { flex: 1; min-width: 0; }

.link-name {
  font-size: 12px;
  color: #18181b;
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.link-item.active .link-name { color: #3b82f6; }
.link-item.rotation-active .link-name { color: #d97706; }

.rotation-badge {
  display: block;
  font-size: 10px;
  color: #f59e0b;
  margin-top: 2px;
}

.active-dot {
  width: 6px;
  height: 6px;
  background: #3b82f6;
  border-radius: 50%;
  flex-shrink: 0;
  animation: pulse 1.5s infinite;
}

.link-item.rotation-active .active-dot {
  background: #f59e0b;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.empty {
  padding: 16px 12px;
  font-size: 11px;
  color: #a1a1aa;
  text-align: center;
}
</style>
