import { defineStore } from 'pinia'
import { ref } from 'vue'

export interface SystemInfo {
  platform: string
  totalMemory: number
  freeMemory: number
  cpuModel: string
  cpuCores: number
  gpu: {
    name: string
    memoryTotal: number
    memoryUsed: number
    utilization: number
  } | null
}

export const useSettingsStore = defineStore('settings', () => {
  const settings = ref<Record<string, string>>({})
  const systemInfo = ref<SystemInfo | null>(null)
  const diskSpace = ref({ free: 0, total: 0 })
  const loading = ref(false)

  async function fetchSettings() {
    try {
      settings.value = await window.api.settingsGetAll()
    } catch (err) {
      console.error('Failed to fetch settings:', err)
    }
  }

  async function updateSetting(key: string, value: string) {
    await window.api.settingsSet(key, value)
    settings.value[key] = value
  }

  function getSetting(key: string, defaultValue: string = ''): string {
    return settings.value[key] ?? defaultValue
  }

  async function fetchSystemInfo() {
    try {
      systemInfo.value = await window.api.getSystemInfo()
    } catch {
      systemInfo.value = null
    }
  }

  async function fetchDiskSpace() {
    try {
      const dataDir = (settings.value.data_dir || '').trim()
      const drive = /^[A-Za-z]:/.test(dataDir) ? dataDir.charAt(0) : ''
      if (!drive) {
        diskSpace.value = { free: 0, total: 0 }
        return
      }
      diskSpace.value = await window.api.getDiskSpace(drive)
    } catch {
      diskSpace.value = { free: 0, total: 0 }
    }
  }

  return {
    settings,
    systemInfo,
    diskSpace,
    loading,
    fetchSettings,
    updateSetting,
    getSetting,
    fetchSystemInfo,
    fetchDiskSpace
  }
})
