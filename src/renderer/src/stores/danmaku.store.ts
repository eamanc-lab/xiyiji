import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export interface DanmakuMsg {
  type: 'danmaku' | 'gift' | 'follow' | 'enter' | 'like' | 'share' | 'reply' | 'system'
  text: string
  username?: string
  uid?: string
  giftName?: string
  count?: number
  timestamp: number
}

export type DanmakuPlatform = 'bilibili' | 'tiktok' | 'douyin' | 'weixin_channel' | 'taobao' | 'xiaohongshu'

export const useDanmakuStore = defineStore('danmaku', () => {
  const connected = ref(false)
  const roomId = ref<string | null>(null)
  const popularity = ref(0)
  const autoReplyEnabled = ref(false)
  const messages = ref<DanmakuMsg[]>([])
  const platform = ref<DanmakuPlatform>('bilibili')
  const connecting = ref(false)
  const error = ref<string | null>(null)

  // Config
  const cooldown = ref(5)

  // Filter settings
  const forbiddenWords = ref<string[]>([])
  const blacklistUsers = ref<string[]>([])
  const minTextLength = ref(2)
  const eventTypeFilters = ref<Record<string, boolean>>({
    danmaku: true,
    gift: true,
    follow: true,
    enter: true,
    like: true,
    share: true
  })

  // Statistics
  const stats = ref({ total: 0, comment: 0, gift: 0, like: 0, follow: 0, enter: 0, reply: 0, success: 0, fail: 0 })

  const MAX_MESSAGES = 500

  // Cleanup handles
  const cleanups: (() => void)[] = []

  // Filtered messages for display (respects eventTypeFilters)
  const filteredMessages = computed(() => {
    return messages.value.filter((msg) => {
      if (msg.type === 'system' || msg.type === 'reply') return true
      return eventTypeFilters.value[msg.type] !== false
    })
  })

  function initListeners() {
    // Bilibili-specific listeners
    cleanups.push(
      window.api.onDanmakuMessage((msg: any) => {
        addMessage({
          type: 'danmaku',
          text: msg.text,
          username: msg.username,
          uid: String(msg.uid || ''),
          timestamp: msg.timestamp || Date.now()
        })
      })
    )

    cleanups.push(
      window.api.onDanmakuConnected((rid: number) => {
        connected.value = true
        connecting.value = false
        roomId.value = String(rid)
        error.value = null
        addMessage({
          type: 'system',
          text: `已连接到直播间 ${rid}`,
          timestamp: Date.now()
        })
      })
    )

    cleanups.push(
      window.api.onDanmakuDisconnected(() => {
        if (platform.value === 'bilibili') {
          connected.value = false
          connecting.value = false
          addMessage({
            type: 'system',
            text: '已断开连接',
            timestamp: Date.now()
          })
        }
      })
    )

    cleanups.push(
      window.api.onDanmakuPopularity((count: number) => {
        popularity.value = count
      })
    )

    cleanups.push(
      window.api.onDanmakuError((err: string) => {
        error.value = err
        connecting.value = false
      })
    )

    // Platform disconnected (e.g. 视频号 window closed by user)
    cleanups.push(
      window.api.onPlatformDisconnected(() => {
        if (platform.value !== 'bilibili' && connected.value) {
          connected.value = false
          connecting.value = false
          roomId.value = null
          addMessage({
            type: 'system',
            text: '平台连接已断开',
            timestamp: Date.now()
          })
        }
      })
    )

    // Platform adapter events (TikTok, Douyin, etc.)
    cleanups.push(
      window.api.onPlatformEvent((event: any) => {
        const typeMap: Record<string, DanmakuMsg['type']> = {
          danmaku: 'danmaku',
          gift: 'gift',
          follow: 'follow',
          enter: 'enter',
          like: 'like',
          share: 'share'
        }
        const msgType = typeMap[event.type] || 'danmaku'

        addMessage({
          type: msgType,
          text: event.text || event.giftName || '',
          username: event.userName || '',
          uid: String(event.userId || ''),
          giftName: event.giftName,
          count: event.count,
          timestamp: event.timestamp || Date.now()
        })
      })
    )
  }

  function destroyListeners() {
    for (const cleanup of cleanups) {
      cleanup()
    }
    cleanups.length = 0
  }

  function addMessage(msg: DanmakuMsg) {
    messages.value.push(msg)
    if (messages.value.length > MAX_MESSAGES) {
      messages.value = messages.value.slice(-MAX_MESSAGES)
    }

    // Update stats
    stats.value.total++
    if (msg.type === 'danmaku') stats.value.comment++
    else if (msg.type === 'gift') stats.value.gift++
    else if (msg.type === 'like') stats.value.like++
    else if (msg.type === 'follow') stats.value.follow++
    else if (msg.type === 'enter') stats.value.enter++
  }

  function clearMessages() {
    messages.value = []
    stats.value = { total: 0, comment: 0, gift: 0, like: 0, follow: 0, enter: 0, reply: 0, success: 0, fail: 0 }
  }

  /** Unified connect: dispatches to Bilibili or Platform adapter based on current platform */
  async function connect(input: string) {
    if (connecting.value || connected.value) return

    connecting.value = true
    error.value = null

    try {
      if (platform.value === 'bilibili') {
        const result = await window.api.danmakuConnect(Number(input))
        if (!result.success) {
          throw new Error(result.error || '连接失败')
        }
      } else if (platform.value === 'tiktok') {
        const apiKey = await window.api.settingsGet('eulerstream_api_key')
        const result = await window.api.platformConnect('tiktok', {
          username: input,
          apiKey: apiKey || ''
        })
        if (!result.ok) {
          throw new Error(result.error || '连接失败')
        }
        connected.value = true
        connecting.value = false
        roomId.value = input
        addMessage({
          type: 'system',
          text: `已连接到 TikTok @${input}`,
          timestamp: Date.now()
        })
      } else if (platform.value === 'douyin') {
        const result = await window.api.platformConnect('douyin', {
          url: input
        })
        if (!result.ok) {
          throw new Error(result.error || '连接失败')
        }
        connected.value = true
        connecting.value = false
        roomId.value = input
        addMessage({
          type: 'system',
          text: `已连接到抖音直播间`,
          timestamp: Date.now()
        })
      } else if (platform.value === 'weixin_channel') {
        const result = await window.api.platformConnect('weixin_channel', {})
        if (!result.ok) {
          throw new Error(result.error || '连接失败')
        }
        // For 视频号, window is open but user may still need to scan QR to login.
        // Mark as connected — the adapter handles login detection internally.
        // If user closes the window, platform:disconnected will reset state.
        connected.value = true
        connecting.value = false
        roomId.value = '视频号直播间'
        addMessage({
          type: 'system',
          text: '视频号管理后台已打开，请在弹出的窗口中扫码登录',
          timestamp: Date.now()
        })
      } else if (platform.value === 'taobao') {
        const result = await window.api.platformConnect('taobao', {
          url: input || ''
        })
        if (!result.ok) {
          throw new Error(result.error || '连接失败')
        }
        connected.value = true
        connecting.value = false
        roomId.value = input || '淘宝直播间'
        addMessage({
          type: 'system',
          text: '淘宝直播页面已打开，请在弹出的窗口中登录并进入直播间',
          timestamp: Date.now()
        })
      } else if (platform.value === 'xiaohongshu') {
        const result = await window.api.platformConnect('xiaohongshu', {})
        if (!result.ok) {
          throw new Error(result.error || '连接失败')
        }
        connected.value = true
        connecting.value = false
        roomId.value = '小红书直播间'
        addMessage({
          type: 'system',
          text: '小红书直播页面已打开，请在弹出的窗口中登录',
          timestamp: Date.now()
        })
      }
    } catch (err: any) {
      error.value = err.message
      connecting.value = false
    }
  }

  /** Unified disconnect */
  async function disconnect() {
    if (platform.value === 'bilibili') {
      await window.api.danmakuDisconnect()
    } else {
      await window.api.platformDisconnect()
    }
    connected.value = false
    connecting.value = false
    roomId.value = null
    popularity.value = 0
    addMessage({
      type: 'system',
      text: '已断开连接',
      timestamp: Date.now()
    })
  }

  return {
    connected,
    roomId,
    popularity,
    autoReplyEnabled,
    messages,
    filteredMessages,
    platform,
    connecting,
    error,
    cooldown,
    forbiddenWords,
    blacklistUsers,
    minTextLength,
    eventTypeFilters,
    stats,
    initListeners,
    destroyListeners,
    addMessage,
    clearMessages,
    connect,
    disconnect
  }
})
