<template>
  <div class="login-page">
    <div class="login-card">
      <div class="login-header">
        <div class="login-logo">🎬</div>
        <h1 class="login-title">数字人直播控制台</h1>
        <p class="login-subtitle">Digital Human Live Streaming Console</p>
      </div>

      <t-alert
        v-if="licenseWarning"
        :message="licenseWarning"
        theme="warning"
        style="margin-bottom: 16px;"
      />

      <t-alert
        v-if="errorMsg"
        :message="errorMsg"
        theme="error"
        style="margin-bottom: 20px;"
        close
        @close="errorMsg = ''"
      />

      <div class="login-form">
        <div class="form-item">
          <t-input
            v-model="account"
            placeholder="请输入账号"
            size="large"
            :disabled="loading"
            @enter="handleLogin"
          >
            <template #prefix-icon>
              <t-icon name="user" />
            </template>
          </t-input>
        </div>

        <div class="form-item">
          <t-input
            v-model="password"
            type="password"
            placeholder="请输入密码"
            size="large"
            :disabled="loading"
            @enter="handleLogin"
          >
            <template #prefix-icon>
              <t-icon name="lock-on" />
            </template>
          </t-input>
        </div>

        <div class="login-options">
          <t-checkbox v-model="rememberLogin">记住登录</t-checkbox>
        </div>

        <t-button
          theme="primary"
          size="large"
          block
          :loading="loading"
          @click="handleLogin"
        >
          {{ loading ? '登录中...' : '登 录' }}
        </t-button>
      </div>

      <div class="update-wrap">
        <AppUpdatePanel compact />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth.store'
import AppUpdatePanel from '../components/system/AppUpdatePanel.vue'

const router = useRouter()
const authStore = useAuthStore()

const loading = ref(false)
const errorMsg = ref('')
const licenseWarning = ref('')
const account = ref('')
const password = ref('')
const rememberLogin = ref(false)

onMounted(async () => {
  // 已有 token 时先检查 license 是否过期
  if (localStorage.getItem('auth_token')) {
    try {
      const licenseInfo = await window.api.licenseGetInfo()
      if (licenseInfo?.status === 'expired') {
        localStorage.removeItem('auth_token')
        errorMsg.value = '授权已过期，请联系管理员续费'
      } else {
        router.push('/lobby')
        return
      }
    } catch {
      router.push('/lobby')
      return
    }
  }
  const savedRemember = localStorage.getItem('remember_login')
  if (savedRemember === 'true') {
    const savedAccount = localStorage.getItem('remembered_account')
    if (savedAccount) {
      account.value = savedAccount
      rememberLogin.value = true
    }
  }
})

async function handleLogin(): Promise<void> {
  errorMsg.value = ''
  licenseWarning.value = ''
  if (!account.value.trim()) {
    errorMsg.value = '请输入账号'
    return
  }
  if (!password.value.trim()) {
    errorMsg.value = '请输入密码'
    return
  }
  loading.value = true
  try {
    // 通过主进程验证账号密码 + license 有效期
    const result = await window.api.licenseLogin(account.value.trim(), password.value.trim())
    if (!result?.ok) {
      errorMsg.value = result?.error || '登录失败，请重试'
      return
    }

    // 登录成功，检查 license 到期提醒
    const licenseInfo = result.info
    const warnings: string[] = []
    if (licenseInfo?.status === 'critical') {
      warnings.push(`授权仅剩 ${licenseInfo.daysRemaining ?? 0} 天，请尽快联系管理员续费`)
    } else if (licenseInfo?.status === 'warn') {
      warnings.push(`授权剩余 ${licenseInfo.daysRemaining} 天，请及时联系管理员续费`)
    }
    if (licenseInfo?.hoursTotal > 0 && licenseInfo?.hoursRemaining !== null && licenseInfo.hoursRemaining < 10) {
      warnings.push(`剩余直播时长仅 ${licenseInfo.hoursRemaining.toFixed(1)} 小时`)
    }
    if (warnings.length > 0) {
      licenseWarning.value = warnings.join('；')
    }

    // 如果有到期警告，显示 1.5 秒后再跳转
    const token = btoa(account.value.trim() + ':' + password.value.trim())
    localStorage.setItem('auth_token', token)
    localStorage.setItem('auth_account', account.value.trim())
    if (rememberLogin.value) {
      localStorage.setItem('remember_login', 'true')
      localStorage.setItem('remembered_account', account.value.trim())
    } else {
      localStorage.removeItem('remember_login')
      localStorage.removeItem('remembered_account')
    }
    authStore.login(token)

    if (licenseWarning.value) {
      await new Promise((r) => setTimeout(r, 1500))
    }
    router.push('/lobby')
  } catch (err: any) {
    errorMsg.value = (err as any)?.message || '登录失败，请重试'
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.login-page {
  height: 100%;
  width: 100%;
  background: #f0f2f5;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 20px;
  box-sizing: border-box;
  position: relative;
}

.login-card {
  background: #ffffff;
  border-radius: 16px;
  padding: 48px 40px 40px;
  width: 100%;
  max-width: 420px;
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.08), 0 0 0 1px rgba(0, 0, 0, 0.04);
}

.login-header {
  text-align: center;
  margin-bottom: 36px;
}

.login-logo {
  font-size: 48px;
  margin-bottom: 12px;
  line-height: 1;
}

.login-title {
  font-size: 22px;
  font-weight: 700;
  color: #18181b;
  margin: 0 0 6px 0;
}

.login-subtitle {
  font-size: 12px;
  color: #71717a;
  margin: 0;
  letter-spacing: 0.5px;
}

.login-form {
  display: flex;
  flex-direction: column;
}

.form-item {
  margin-bottom: 18px;
}

.login-options {
  display: flex;
  align-items: center;
  margin-bottom: 24px;
}

.update-wrap {
  margin-top: 20px;
}
</style>
