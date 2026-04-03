import { EventEmitter } from 'events'
import WebSocket from 'ws'
import type { PlatformAdapter, LiveEvent } from './adapter.interface'

const DOUYIN_WS_PORT = 2345

/**
 * Douyin (抖音) platform adapter.
 *
 * Connects to a local WebSocket proxy (default port 2345) that captures
 * live-stream events from the Douyin client and forwards them as JSON.
 *
 * Expected message format from the proxy:
 *   { type: 'comment'|'gift'|'follow'|'enter'|'like'|'share',
 *     userId: string, userName: string, content?: string,
 *     giftName?: string, count?: number }
 */
export class DouyinAdapter extends EventEmitter implements PlatformAdapter {
  readonly platform = 'douyin'

  private ws: WebSocket | null = null
  private status: 'connected' | 'disconnected' | 'error' = 'disconnected'
  private eventCallback: ((event: LiveEvent) => void) | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectInterval = 5_000
  private credential: any = null
  private shouldReconnect = false

  async connect(credential: any): Promise<void> {
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
      const port = this.credential?.port || DOUYIN_WS_PORT
      const url = `ws://127.0.0.1:${port}`

      console.log(`[Douyin] Connecting to ${url}`)

      const ws = new WebSocket(url)
      this.ws = ws

      // Ensure the promise settles exactly once (open/error/close/timeout race)
      let settled = false

      const timeout = setTimeout(() => {
        ws.terminate()
        if (!settled) { settled = true; reject(new Error('Douyin WS connect timeout')) }
      }, 5_000)

      ws.on('open', () => {
        clearTimeout(timeout)
        this.status = 'connected'
        console.log('[Douyin] Connected')
        if (!settled) { settled = true; resolve() }
      })

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString())
          this.handleMessage(msg)
        } catch {
          // ignore malformed messages
        }
      })

      ws.on('close', () => {
        clearTimeout(timeout)
        this.status = 'disconnected'
        console.log('[Douyin] Disconnected')
        if (!settled) { settled = true; reject(new Error('Douyin WS closed before open')) }
        if (this.shouldReconnect) {
          this.scheduleReconnect()
        }
      })

      ws.on('error', (err) => {
        clearTimeout(timeout)
        this.status = 'error'
        console.error('[Douyin] WS error:', err.message)
        if (!settled) { settled = true; reject(err) }
      })
    })
  }

  private handleMessage(msg: any): void {
    if (!this.eventCallback) return

    const typeMap: Record<string, LiveEvent['type']> = {
      comment: 'danmaku',
      chat: 'danmaku',
      gift: 'gift',
      follow: 'follow',
      enter: 'enter',
      like: 'like',
      share: 'share'
    }

    const evType = typeMap[msg.type]
    if (!evType) return // skip unknown message types (heartbeat, status, etc.)

    const text = msg.content || msg.text || ''

    // Skip empty-content comments — they waste LLM generation
    if (evType === 'danmaku' && !text.trim()) return

    const event: LiveEvent = {
      type: evType,
      userId: String(msg.userId || msg.user_id || ''),
      userName: msg.userName || msg.nickname || msg.user_name || '',
      text,
      giftName: msg.giftName || msg.gift_name,
      count: msg.count || msg.giftCount,
      timestamp: msg.timestamp || Date.now()
    }

    this.eventCallback(event)
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null
      if (!this.shouldReconnect) return
      console.log('[Douyin] Attempting reconnect...')
      try {
        await this.tryConnect()
      } catch {
        // will retry again on next close
      }
    }, this.reconnectInterval)
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
    console.log('[Douyin] Disconnected by user')
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
