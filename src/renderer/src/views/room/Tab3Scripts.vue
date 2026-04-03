<template>
  <div class="tab-scripts">
    <div class="scripts-nav">
      <button
        v-for="t in scriptTabs"
        :key="t.key"
        class="scripts-tab"
        :class="{ active: activeScript === t.key }"
        @click="activeScript = t.key"
      >
        {{ t.label }}
      </button>
    </div>
    <div class="scripts-content">
      <general-script v-if="activeScript === 'general'" :room-id="roomId" />
      <link-scripts v-else-if="activeScript === 'links'" :room-id="roomId" />
      <shortcut-scripts v-else-if="activeScript === 'shortcuts'" :room-id="roomId" />
      <room-settings-panel v-else-if="activeScript === 'settings'" :room-id="roomId" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import GeneralScript from './scripts/GeneralScript.vue'
import LinkScripts from './scripts/LinkScripts.vue'
import ShortcutScripts from './scripts/ShortcutScripts.vue'
import RoomSettingsPanel from './scripts/RoomSettings.vue'

defineProps<{ roomId: string }>()

const activeScript = ref('general')
const scriptTabs = [
  { key: 'general', label: '通用脚本' },
  { key: 'links', label: '链接脚本' },
  { key: 'shortcuts', label: '快捷键脚本' },
  { key: 'settings', label: 'AI设置' }
]
</script>

<style scoped>
.tab-scripts { display: flex; flex-direction: column; height: 100%; overflow: hidden; }

.scripts-nav {
  display: flex;
  gap: 0;
  background: #ffffff;
  border-bottom: 1px solid #e4e4e7;
  padding: 0 20px;
}

.scripts-tab {
  padding: 9px 20px;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: #71717a;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.15s;
}
.scripts-tab:hover { color: #18181b; }
.scripts-tab.active { color: #4a9eff; border-bottom-color: #4a9eff; }

.scripts-content { flex: 1; overflow: hidden; }
</style>
