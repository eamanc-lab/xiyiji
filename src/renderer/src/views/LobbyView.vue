<template>
  <div class="lobby">
    <!-- License banner -->
    <div v-if="licenseBanner" class="license-banner" :class="`banner-${licenseBannerLevel}`">
      {{ licenseBanner }}
    </div>

    <!-- Header bar -->
    <div class="lobby-header">
      <span class="lobby-title">直播间管理</span>
      <div class="header-actions">
        <button class="btn-primary" @click="showCreate = true">+ 新建直播间</button>
      </div>
    </div>

    <!-- Room grid -->
    <div class="room-grid">
      <div
        v-for="room in rooms"
        :key="room.id"
        class="room-card"
        :class="{ 'is-running': room.status === 'running' }"
        @click="openRoom(room.id)"
      >
        <div class="room-card-header">
          <span class="room-name">{{ room.name }}</span>
          <span class="room-status" :class="`status-${room.status}`">
            {{ statusLabel(room.status) }}
          </span>
        </div>
        <div class="room-meta">
          <span>平台: {{ platformLabel(room.platform) }}</span>
          <span v-if="room.profile_name">形象: {{ room.profile_name }}</span>
          <span v-else class="no-profile">未配置形象</span>
        </div>
        <div class="room-card-actions" @click.stop>
          <button class="action-btn" title="复制" @click="handleCopy(room)">复制</button>
          <button class="action-btn danger" title="删除" @click="handleDelete(room)">删除</button>
        </div>
      </div>

      <!-- Empty state -->
      <div v-if="rooms.length === 0 && !loading" class="empty-state">
        <p>暂无直播间，点击「新建直播间」开始</p>
      </div>
    </div>

    <!-- Create dialog -->
    <div v-if="showCreate" class="dialog-mask" @click.self="showCreate = false">
      <div class="dialog">
        <div class="dialog-title">新建直播间</div>
        <div class="dialog-body">
          <div class="field">
            <label>名称</label>
            <input v-model="createForm.name" placeholder="直播间名称" maxlength="50" />
          </div>
          <div class="field">
            <label>平台</label>
            <select v-model="createForm.platform">
              <option value="douyin">抖音</option>
              <option value="taobao">淘宝</option>
              <option value="xiaohongshu">小红书</option>
              <option value="tiktok">TikTok</option>
              <option value="weixin_channel">视频号</option>
            </select>
          </div>
        </div>
        <div class="dialog-footer">
          <button class="btn-ghost" @click="showCreate = false">取消</button>
          <button class="btn-primary" :disabled="!createForm.name.trim()" @click="handleCreate">创建</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useRoomStore, type Room } from '../stores/room.store'
import { storeToRefs } from 'pinia'

const router = useRouter()
const roomStore = useRoomStore()
const { rooms, loading } = storeToRefs(roomStore)

const showCreate = ref(false)
const createForm = ref({ name: '', platform: 'douyin' })
const licenseBanner = ref('')
const licenseBannerLevel = ref<'warn' | 'critical'>('warn')

onMounted(async () => {
  roomStore.fetchRooms()
  const info = await window.api.licenseGetInfo()
  if (info?.status === 'critical') {
    licenseBanner.value = `License 仅剩 ${info.daysRemaining ?? 0} 天，请立即续费！`
    licenseBannerLevel.value = 'critical'
  } else if (info?.status === 'warn') {
    licenseBanner.value = `License 剩余 ${info.daysRemaining} 天，请及时续费`
    licenseBannerLevel.value = 'warn'
  }
})

function statusLabel(status: string): string {
  const map: Record<string, string> = {
    idle: '待机',
    running: '直播中',
    paused: '暂停'
  }
  return map[status] || status
}

function platformLabel(platform: string): string {
  const map: Record<string, string> = {
    douyin: '抖音',
    taobao: '淘宝',
    xiaohongshu: '小红书',
    tiktok: 'TikTok',
    weixin_channel: '视频号'
  }
  return map[platform] || platform
}

function openRoom(id: string): void {
  router.push(`/room/${id}`)
}

async function handleCreate(): Promise<void> {
  if (!createForm.value.name.trim()) return
  await roomStore.createRoom({
    name: createForm.value.name.trim(),
    platform: createForm.value.platform
  })
  showCreate.value = false
  createForm.value = { name: '', platform: 'douyin' }
}

async function handleCopy(room: Room): Promise<void> {
  const newName = room.name + ' (副本)'
  await roomStore.copyRoom(room.id, newName)
}

async function handleDelete(room: Room): Promise<void> {
  if (room.status === 'running') {
    alert('请先停止直播后再删除')
    return
  }
  if (!confirm(`确认删除「${room.name}」？`)) return
  const result = await roomStore.deleteRoom(room.id)
  if (result?.ok === false) {
    alert(result.error || '删除失败')
  }
}
</script>

<style scoped>
.lobby {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: #f5f5f7;
  padding: 24px;
  gap: 20px;
}

.license-banner {
  padding: 10px 16px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 500;
}
.banner-warn { background: #fef9c3; color: #ca8a04; border: 1px solid #fde047; }
.banner-critical { background: #fee2e2; color: #dc2626; border: 1px solid #fca5a5; }

.lobby-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 42px;
  flex-shrink: 0;
}

.lobby-title {
  font-size: 20px;
  font-weight: 600;
  color: #18181b;
}

.room-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 16px;
  overflow-y: auto;
}

.room-card {
  background: #ffffff;
  border: 1px solid #e4e4e7;
  border-radius: 8px;
  padding: 16px;
  cursor: pointer;
  transition: border-color 0.2s, transform 0.1s, box-shadow 0.2s;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.room-card:hover {
  border-color: #a1a1aa;
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.06);
}

.room-card.is-running {
  border-color: #16a34a;
}

.room-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.room-name {
  font-size: 15px;
  font-weight: 600;
  color: #18181b;
}

.room-status {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
}

.status-idle { background: #f4f4f5; color: #71717a; }
.status-running { background: #dcfce7; color: #16a34a; }
.status-paused { background: #fef9c3; color: #ca8a04; }

.room-meta {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: #71717a;
}

.no-profile { color: #ca8a04; }

.room-card-actions {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}

.action-btn {
  font-size: 12px;
  padding: 4px 10px;
  border: 1px solid #e4e4e7;
  border-radius: 4px;
  background: transparent;
  color: #71717a;
  cursor: pointer;
  transition: all 0.15s;
}

.action-btn:hover { color: #18181b; border-color: #a1a1aa; }
.action-btn.danger:hover { color: #dc2626; border-color: #dc2626; }

.empty-state {
  grid-column: 1 / -1;
  text-align: center;
  padding: 80px 0;
  color: #a1a1aa;
  font-size: 14px;
}

/* Dialog */
.dialog-mask {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}

.dialog {
  background: #ffffff;
  border: 1px solid #e4e4e7;
  border-radius: 10px;
  padding: 24px;
  width: 360px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.12);
}

.dialog-title { font-size: 16px; font-weight: 600; color: #18181b; margin-bottom: 20px; }
.dialog-body { display: flex; flex-direction: column; gap: 14px; }
.dialog-footer { display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px; }

.field label { display: block; font-size: 12px; color: #71717a; margin-bottom: 6px; }
.field input,
.field select {
  width: 100%;
  padding: 8px 12px;
  background: #f9f9fb;
  border: 1px solid #e4e4e7;
  border-radius: 6px;
  color: #18181b;
  font-size: 14px;
  outline: none;
}
.field input:focus,
.field select:focus { border-color: #4a9eff; }

.btn-primary {
  padding: 8px 20px;
  background: #4a9eff;
  border: none;
  border-radius: 6px;
  color: #fff;
  font-size: 14px;
  cursor: pointer;
}
.btn-primary:hover:not(:disabled) { background: #3a8ef0; }
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }

.btn-ghost {
  padding: 8px 20px;
  background: transparent;
  border: 1px solid #e4e4e7;
  border-radius: 6px;
  color: #71717a;
  font-size: 14px;
  cursor: pointer;
}
.btn-ghost:hover { color: #18181b; border-color: #a1a1aa; }
</style>
