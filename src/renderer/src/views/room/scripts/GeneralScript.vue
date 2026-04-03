<template>
  <div class="general-script">
    <div class="script-header">
      <span class="hint">通用脚本会在无弹幕或链接脚本时循环播放，AI会以此为参考生成话术</span>
      <button class="btn-save" :disabled="saving" @click="handleSave">
        {{ saving ? '保存中...' : '保存' }}
      </button>
    </div>
    <textarea
      v-model="content"
      class="script-textarea"
      placeholder="输入通用直播话术脚本...

示例：
欢迎各位宝宝来到直播间！今天给大家带来了非常好的产品，质量超棒价格也很优惠。
有任何问题可以在弹幕里问我，我会一一解答。喜欢的话记得点个关注哦！"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'

const props = defineProps<{ roomId: string }>()

const content = ref('')
const saving = ref(false)

async function load(): Promise<void> {
  const data = await window.api.scriptGetGeneral(props.roomId)
  content.value = data?.content || ''
}

async function handleSave(): Promise<void> {
  saving.value = true
  try {
    await window.api.scriptSaveGeneral(props.roomId, content.value)
  } finally {
    saving.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.general-script {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 20px;
  gap: 12px;
  background: #ffffff;
}

.script-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.hint { font-size: 12px; color: #71717a; flex: 1; }

.btn-save {
  padding: 7px 18px;
  background: #4a9eff;
  border: none;
  border-radius: 6px;
  color: #fff;
  font-size: 13px;
  cursor: pointer;
  flex-shrink: 0;
}
.btn-save:hover:not(:disabled) { background: #3a8ef0; }
.btn-save:disabled { opacity: 0.6; cursor: not-allowed; }

.script-textarea {
  flex: 1;
  width: 100%;
  padding: 14px;
  background: #f9f9fb;
  border: 1px solid #e4e4e7;
  border-radius: 8px;
  color: #18181b;
  font-size: 14px;
  line-height: 1.7;
  resize: none;
  outline: none;
  font-family: inherit;
  transition: border-color 0.2s;
}
.script-textarea:focus { border-color: #4a9eff; }
</style>
