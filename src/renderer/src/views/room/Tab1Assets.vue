<template>
  <div class="tab-assets">
    <div class="toolbar">
      <button class="btn-primary" @click="handleImport">+ 导入视频</button>
    </div>

    <div class="asset-grid">
      <div
        v-for="asset in assets"
        :key="asset.id"
        class="asset-card"
        :class="{ 'face-ok': asset.face_detected }"
      >
        <div class="asset-thumb">
          <img v-if="asset.thumbnail_path" :src="`file://${asset.thumbnail_path}`" />
          <div v-else class="thumb-placeholder">🎬</div>
          <div v-if="asset.face_detected" class="face-badge">✓ 人脸已检测</div>
        </div>
        <div class="asset-info">
          <div class="asset-name" :title="asset.name">{{ asset.name }}</div>
          <div class="asset-path" :title="asset.file_path">{{ shortPath(asset.file_path) }}</div>
        </div>
        <div class="asset-actions">
          <button class="action-btn" @click="handleRename(asset)">重命名</button>
          <button class="action-btn danger" @click="handleDelete(asset)">删除</button>
        </div>
      </div>

      <div v-if="assets.length === 0 && !loading" class="empty">
        暂无素材，点击「导入视频」添加数字人视频
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'

const props = defineProps<{ roomId: string }>()

const assets = ref<any[]>([])
const loading = ref(false)

async function loadAssets(): Promise<void> {
  loading.value = true
  try {
    assets.value = (await window.api.assetList()) || []
  } finally {
    loading.value = false
  }
}

function shortPath(p: string): string {
  if (!p) return ''
  const parts = p.replace(/\\/g, '/').split('/')
  return parts.length > 2 ? `.../${parts.slice(-2).join('/')}` : p
}

async function handleImport(): Promise<void> {
  const res = await window.api.selectVideoFile()
  const file = (res as any)?.path ?? res
  if (!file) return
  const name = (file as string).replace(/\\/g, '/').split('/').pop() || '未命名'
  const result = await window.api.assetImport({ filePath: file, name })
  if (result?.ok === false) {
    alert(result.error || '导入失败')
    return
  }
  await loadAssets()
}

async function handleRename(asset: any): Promise<void> {
  const name = prompt('新名称:', asset.name)
  if (!name?.trim()) return
  await window.api.assetRename(asset.id, name.trim())
  await loadAssets()
}

async function handleDelete(asset: any): Promise<void> {
  if (!confirm(`确认删除素材「${asset.name}」？此操作不可撤销。`)) return
  const result = await window.api.assetDelete(asset.id)
  if (result?.ok === false) {
    alert(result.error || '删除失败')
    return
  }
  await loadAssets()
}

onMounted(loadAssets)
</script>

<style scoped>
.tab-assets {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 20px;
  gap: 16px;
  overflow: hidden;
}

.toolbar { display: flex; gap: 10px; }

.asset-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 14px;
  overflow-y: auto;
}

.asset-card {
  background: #ffffff;
  border: 1px solid #e4e4e7;
  border-radius: 8px;
  overflow: hidden;
  transition: border-color 0.2s, box-shadow 0.2s;
}
.asset-card.face-ok { border-color: #16a34a; }
.asset-card:hover { border-color: #a1a1aa; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }

.asset-thumb {
  position: relative;
  height: 120px;
  background: #f4f4f5;
  display: flex;
  align-items: center;
  justify-content: center;
}
.asset-thumb img { width: 100%; height: 100%; object-fit: cover; }
.thumb-placeholder { font-size: 40px; color: #d4d4d8; }
.face-badge {
  position: absolute;
  bottom: 4px;
  right: 4px;
  background: rgba(22, 163, 74, 0.9);
  color: #fff;
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 4px;
}

.asset-info { padding: 10px 12px 6px; }
.asset-name { font-size: 13px; color: #18181b; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.asset-path { font-size: 11px; color: #a1a1aa; margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.asset-actions {
  display: flex;
  gap: 6px;
  padding: 6px 10px 10px;
}
.action-btn { font-size: 12px; padding: 3px 10px; border: 1px solid #e4e4e7; border-radius: 4px; background: transparent; color: #71717a; cursor: pointer; }
.action-btn:hover { color: #18181b; border-color: #a1a1aa; }
.action-btn.danger:hover { color: #dc2626; border-color: #dc2626; }

.empty { grid-column: 1/-1; text-align: center; padding: 60px 0; color: #a1a1aa; }

.btn-primary { padding: 8px 18px; background: #4a9eff; border: none; border-radius: 6px; color: #fff; font-size: 14px; cursor: pointer; }
.btn-primary:hover { background: #3a8ef0; }
</style>
