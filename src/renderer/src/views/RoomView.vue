<template>
  <div class="room-view">
    <!-- Top bar -->
    <div class="room-topbar">
      <button class="back-btn" @click="router.push('/lobby')">← 返回</button>
      <span class="room-name">{{ room?.name || '加载中...' }}</span>
      <div class="room-status" :class="`status-${room?.status || 'idle'}`">
        {{ statusLabel(room?.status) }}
      </div>
    </div>

    <!-- Tab navigation -->
    <div class="tab-nav">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        class="tab-btn"
        :class="{ active: activeTab === tab.key }"
        @click="activeTab = tab.key"
      >
        {{ tab.label }}
      </button>
    </div>

    <!-- Tab content -->
    <div class="tab-content">
      <tab1-assets v-if="activeTab === 'assets'" :room-id="roomId" />
      <tab2-profiles v-else-if="activeTab === 'profiles'" :room-id="roomId" />
      <tab3-scripts v-else-if="activeTab === 'scripts'" :room-id="roomId" />
      <tab4-live v-else-if="activeTab === 'live'" :room-id="roomId" :room="room" />
      <tab5-danmaku v-else-if="activeTab === 'danmaku'" :room-id="roomId" />
      <tab6-settings v-else-if="activeTab === 'settings'" :room-id="roomId" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Tab1Assets from './room/Tab1Assets.vue'
import Tab2Profiles from './room/Tab2Profiles.vue'
import Tab3Scripts from './room/Tab3Scripts.vue'
import Tab4Live from './room/Tab4Live.vue'
import Tab5Danmaku from './room/Tab5Danmaku.vue'
import Tab6Settings from './room/Tab6Settings.vue'

const route = useRoute()
const router = useRouter()

const roomId = computed(() => route.params.id as string)
const room = ref<any>(null)
const activeTab = ref('assets')

const tabs = [
  { key: 'assets', label: '形象素材' },
  { key: 'profiles', label: '形象配置' },
  { key: 'scripts', label: '脚本管理' },
  { key: 'live', label: '直播控制' },
  { key: 'danmaku', label: '弹幕互动' },
  { key: 'settings', label: '系统设置' }
]

function statusLabel(status?: string): string {
  const map: Record<string, string> = { idle: '待机', running: '直播中', paused: '暂停' }
  return map[status || 'idle'] || '待机'
}

onMounted(async () => {
  room.value = await window.api.roomGet(roomId.value)
})
</script>

<style scoped>
.room-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: #f5f5f7;
}

.room-topbar {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 0 8px 0 20px;
  height: 44px;
  background: #ffffff;
  border-bottom: 1px solid #e4e4e7;
  flex-shrink: 0;
}

.back-btn {
  background: transparent;
  border: none;
  color: #71717a;
  font-size: 14px;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 4px;
  transition: color 0.2s;
}
.back-btn:hover { color: #18181b; }

.room-name {
  font-size: 16px;
  font-weight: 600;
  color: #18181b;
  flex: 1;
}

.room-status {
  font-size: 12px;
  padding: 3px 10px;
  border-radius: 10px;
}
.status-idle { background: #f4f4f5; color: #71717a; }
.status-running { background: #dcfce7; color: #16a34a; }
.status-paused { background: #fef9c3; color: #ca8a04; }

.tab-nav {
  display: flex;
  gap: 0;
  background: #ffffff;
  border-bottom: 1px solid #e4e4e7;
  flex-shrink: 0;
}

.tab-btn {
  padding: 10px 24px;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: #71717a;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.15s;
}
.tab-btn:hover { color: #18181b; }
.tab-btn.active { color: #4a9eff; border-bottom-color: #4a9eff; }

.tab-content {
  flex: 1;
  overflow: hidden;
}
</style>
