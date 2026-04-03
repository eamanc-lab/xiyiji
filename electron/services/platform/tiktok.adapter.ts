import WebSocket from 'ws'
import type { PlatformAdapter, LiveEvent } from './adapter.interface'

/**
 * TikTok platform adapter using EulerStream WebSocket API.
 *
 * Connects to wss://ws.eulerstream.com with a TikTok username and API key.
 * Receives real-time live stream events (chat, gift, like, member, social).
 */
export class TikTokAdapter implements PlatformAdapter {
  readonly platform = 'tiktok'

  private ws: WebSocket | null = null
  private status: 'connected' | 'disconnected' | 'error' = 'disconnected'
  private eventCallback: ((event: LiveEvent) => void) | null = null
  private shouldReconnect = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private credential: { username: string; apiKey: string } | null = null

  async connect(credential: { username: string; apiKey: string }): Promise<void> {
    // Clean up any lingering connection / background reconnect from a previous attempt
    this.shouldReconnect = false
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      this.ws.removeAllListeners()
      this.ws.terminate()
      this.ws = null
    }

    this.credential = credential
    this.shouldReconnect = true
    return this.tryConnect()
  }

  private tryConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.credential) {
        reject(new Error('No credential'))
        return
      }

      const { username, apiKey } = this.credential
      if (!username || !apiKey) {
        reject(new Error('Missing username or apiKey'))
        return
      }

      const url = `wss://ws.eulerstream.com?uniqueId=${encodeURIComponent(username)}&apiKey=${apiKey}`
      console.log(`[TikTok] Connecting to EulerStream for user: ${username}`)

      const ws = new WebSocket(url, {
        rejectUnauthorized: false // EulerStream may have cert issues
      })
      this.ws = ws

      // Ensure the promise settles exactly once (open/error/close/timeout race)
      let settled = false

      const timeout = setTimeout(() => {
        ws.terminate()
        if (!settled) { settled = true; reject(new Error('TikTok WS connect timeout')) }
      }, 15_000)

      ws.on('open', () => {
        clearTimeout(timeout)
        this.status = 'connected'
        console.log('[TikTok] Connected to EulerStream')
        if (!settled) { settled = true; resolve() }
      })

      ws.on('message', (data) => {
        try {
          const json = JSON.parse(data.toString())
          this.handleMessage(json)
        } catch {
          // ignore malformed messages
        }
      })

      ws.on('close', () => {
        clearTimeout(timeout)
        const wasConnected = this.status === 'connected'
        this.status = 'disconnected'
        if (wasConnected) {
          console.log('[TikTok] Disconnected')
        }
        if (!settled) { settled = true; reject(new Error('TikTok WS closed before open')) }
        if (this.shouldReconnect) {
          this.scheduleReconnect()
        }
      })

      ws.on('error', (err) => {
        clearTimeout(timeout)
        this.status = 'error'
        console.error('[TikTok] WS error:', err.message)
        if (!settled) { settled = true; reject(err) }
      })
    })
  }

  private handleMessage(json: any): void {
    if (!this.eventCallback) return

    // EulerStream sends { messages: [...] } envelope
    const messages = json.messages || (Array.isArray(json) ? json : [json])

    for (const msg of messages) {
      const event = this.parseMessage(msg)
      if (event) {
        this.eventCallback(event)
      }
    }
  }

  private parseMessage(msg: any): LiveEvent | null {
    const msgType = msg.type || ''
    const msgData = msg.data || msg

    // Extract user info (EulerStream nests under data.user)
    const user = msgData.user || {}
    const userId = String(user.uniqueId || user.userId || msg.uniqueId || '')
    const userName = user.nickname || user.uniqueId || msg.nickname || msg.uniqueId || ''

    if (msgType === 'WebcastChatMessage') {
      const comment = msgData.comment || msgData.text || msg.comment || ''
      if (!comment) return null
      return {
        type: 'danmaku',
        userId,
        userName,
        text: comment,
        timestamp: Date.now()
      }
    }

    if (msgType === 'WebcastGiftMessage') {
      // Gift info may be in data.common.describe or structured fields
      let giftName = ''
      let giftCount = 1

      const describe = msgData.common?.describe || ''
      if (describe) {
        // Format: "User: gifted the host 1 Heart Me"
        const parts = describe.split('gifted the host')
        if (parts.length === 2) {
          const info = parts[1].trim()
          const match = info.match(/^(\d+)\s+(.+)$/)
          if (match) {
            giftCount = parseInt(match[1], 10) || 1
            giftName = match[2]
          } else {
            giftName = info
          }
        } else {
          giftName = describe
        }
      }

      if (!giftName) {
        giftName = msgData.gift?.name || msgData.giftName || 'Gift'
        giftCount = msgData.repeatCount || msgData.giftCount || 1
      }

      return {
        type: 'gift',
        userId,
        userName,
        giftName,
        count: giftCount,
        timestamp: Date.now()
      }
    }

    if (msgType === 'WebcastLikeMessage') {
      return {
        type: 'like',
        userId,
        userName,
        count: msgData.likeCount || msgData.count || 1,
        timestamp: Date.now()
      }
    }

    if (msgType === 'WebcastMemberMessage') {
      return {
        type: 'enter',
        userId,
        userName,
        timestamp: Date.now()
      }
    }

    if (msgType === 'WebcastSocialMessage') {
      const action = msgData.action || 0
      if (action === 2) {
        return {
          type: 'share',
          userId,
          userName,
          timestamp: Date.now()
        }
      }
      // Default to follow (action=1 or other)
      return {
        type: 'follow',
        userId,
        userName,
        timestamp: Date.now()
      }
    }

    return null
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null
      if (!this.shouldReconnect) return
      console.log('[TikTok] Attempting reconnect...')
      try {
        await this.tryConnect()
      } catch {
        // will retry on next close
      }
    }, 5_000)
  }

  disconnect(): void {
    this.shouldReconnect = false
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      this.ws.terminate()
      this.ws = null
    }
    this.status = 'disconnected'
    console.log('[TikTok] Disconnected by user')
  }

  getStatus(): 'connected' | 'disconnected' | 'error' {
    return this.status
  }

  onEvent(callback: (event: LiveEvent) => void): void {
    this.eventCallback = callback
  }

  offEvent(): void {
    this.eventCallback = null
  }
}
