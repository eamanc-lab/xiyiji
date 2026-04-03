<template>
  <div class="win-bar">
    <button class="wc-btn" title="最小化" @click="minimize">
      <svg viewBox="0 0 12 12"><rect x="1" y="5.5" width="10" height="1" fill="currentColor"/></svg>
    </button>
    <button class="wc-btn" :title="maximized ? '还原' : '最大化'" @click="toggleMax">
      <svg v-if="!maximized" viewBox="0 0 12 12">
        <rect x="1.5" y="1.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1"/>
      </svg>
      <svg v-else viewBox="0 0 12 12">
        <rect x="2.5" y="0.5" width="8" height="8" fill="none" stroke="currentColor" stroke-width="1"/>
        <rect x="0.5" y="2.5" width="8" height="8" fill="currentColor" stroke="currentColor" stroke-width="1"/>
      </svg>
    </button>
    <button class="wc-btn close" title="关闭" @click="close">
      <svg viewBox="0 0 12 12">
        <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" stroke-width="1.2"/>
      </svg>
    </button>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'

const maximized = ref(false)

function minimize(): void {
  window.api.windowMinimize()
}

async function toggleMax(): Promise<void> {
  await window.api.windowMaximize()
  maximized.value = await window.api.windowIsMaximized()
}

function close(): void {
  window.api.windowClose()
}

onMounted(async () => {
  maximized.value = await window.api.windowIsMaximized()
})
</script>

<style scoped>
.win-bar {
  display: flex;
  align-items: center;
  height: 100%;
}

.wc-btn {
  width: 40px;
  height: 100%;
  border: none;
  background: transparent;
  color: #71717a;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.12s, color 0.12s;
  flex-shrink: 0;
}

.wc-btn:hover {
  background: rgba(0, 0, 0, 0.08);
  color: #18181b;
}

.wc-btn.close:hover {
  background: #dc2626;
  color: #ffffff;
}

.wc-btn svg {
  width: 12px;
  height: 12px;
  pointer-events: none;
}
</style>
