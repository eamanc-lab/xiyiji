<script setup lang="ts">
import { computed } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'

const router = useRouter()
const route = useRoute()
const { t } = useI18n()

const navItems = computed(() => [
  { path: '/avatar-select', label: t('nav.avatarSelect'), icon: 'avatar' },
  { path: '/digital-live', label: t('nav.digitalLive'), icon: 'live' },
  { path: '/digital-chat', label: t('nav.digitalChat'), icon: 'chat' },
  { path: '/param-settings', label: t('nav.paramSettings'), icon: 'settings' }
])

function navigate(path: string) {
  router.push(path)
}
</script>

<template>
  <nav class="sidebar">
    <div class="sidebar-logo">
      <span class="logo-text">西</span>
    </div>
    <div class="nav-items">
      <div
        v-for="item in navItems"
        :key="item.path"
        class="nav-item"
        :class="{ active: route.path === item.path }"
        @click="navigate(item.path)"
        :title="item.label"
      >
        <div class="nav-icon">
          <!-- 形象选择 -->
          <svg v-if="item.icon === 'avatar'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="12" cy="8" r="4"/>
            <path d="M4 21v-1a4 4 0 014-4h8a4 4 0 014 4v1"/>
          </svg>
          <!-- 数字人直播 -->
          <svg v-if="item.icon === 'live'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="2" y="4" width="15" height="16" rx="2"/>
            <path d="M17 8l5-3v14l-5-3z"/>
          </svg>
          <!-- 数字人对话 -->
          <svg v-if="item.icon === 'chat'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
          </svg>
          <!-- 参数设置 -->
          <svg v-if="item.icon === 'settings'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="12" cy="12" r="3"/>
            <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
          </svg>
        </div>
        <span class="nav-label">{{ item.label }}</span>
      </div>
    </div>
  </nav>
</template>

<style scoped>
.sidebar {
  width: 72px;
  background: var(--bg-primary);
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 8px 0;
  border-right: 1px solid var(--border-color);
}

.sidebar-logo {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  background: linear-gradient(135deg, var(--primary-color), #7c3aed);
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 20px;
  margin-top: 4px;
}

.logo-text {
  color: white;
  font-size: 18px;
  font-weight: bold;
}

.nav-items {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
}

.nav-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 8px 4px;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s;
  width: 64px;
}

.nav-item:hover {
  background: var(--bg-hover);
}

.nav-item.active {
  background: var(--bg-tertiary);
  color: var(--primary-color);
}

.nav-icon {
  width: 22px;
  height: 22px;
  margin-bottom: 3px;
}

.nav-icon svg {
  width: 100%;
  height: 100%;
}

.nav-label {
  font-size: 10px;
  color: var(--text-secondary);
  white-space: nowrap;
}

.nav-item.active .nav-label {
  color: var(--primary-color);
}
</style>
