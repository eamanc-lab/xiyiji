import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export const useAuthStore = defineStore('auth', () => {
  const token = ref<string>(localStorage.getItem('token') || '')

  const isLoggedIn = computed(() => !!token.value)

  function login(newToken: string): void {
    token.value = newToken
    localStorage.setItem('token', newToken)
  }

  function logout(): void {
    token.value = ''
    localStorage.removeItem('token')
  }

  return { token, isLoggedIn, login, logout }
})
