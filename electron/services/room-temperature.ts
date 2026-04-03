import { BrowserWindow } from 'electron'

export type RoomTemperature = 'cold' | 'warm' | 'hot' | 'fire'

export interface TemperatureSnapshot {
  temperature: RoomTemperature
  commentsPerMin: number
  giftsPerMin: number
  totalPerMin: number
}

/**
 * Sliding-window room temperature service.
 * Tracks events over the last 60 seconds and computes a temperature level.
 * Uses hysteresis (2 consecutive readings) to avoid jitter.
 */
class RoomTemperatureService {
  private events: Array<{ type: string; ts: number }> = []
  private windowMs = 60_000 // 60 second sliding window
  private timer: ReturnType<typeof setInterval> | null = null

  private current: RoomTemperature = 'cold'
  private pending: RoomTemperature | null = null // hysteresis: must see same value twice

  recordEvent(type: string): void {
    this.events.push({ type, ts: Date.now() })
  }

  getTemperature(): RoomTemperature {
    return this.current
  }

  getSnapshot(): TemperatureSnapshot {
    this.pruneOld()
    const now = Date.now()
    const windowStart = now - this.windowMs

    let comments = 0
    let gifts = 0
    let total = 0
    for (const e of this.events) {
      if (e.ts < windowStart) continue
      total++
      if (e.type === 'comment') comments++
      else if (e.type === 'gift') gifts++
    }

    return {
      temperature: this.current,
      commentsPerMin: comments,
      giftsPerMin: gifts,
      totalPerMin: total
    }
  }

  start(): void {
    if (this.timer) return
    this.events = []
    this.current = 'cold'
    this.pending = null
    this.timer = setInterval(() => this.recalculate(), 5_000)
    console.log('[RoomTemperature] Started')
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.events = []
    this.current = 'cold'
    this.pending = null
    console.log('[RoomTemperature] Stopped')
  }

  private pruneOld(): void {
    const cutoff = Date.now() - this.windowMs
    // Find first event within window (events are roughly time-ordered)
    let i = 0
    while (i < this.events.length && this.events[i].ts < cutoff) i++
    if (i > 0) this.events.splice(0, i)
  }

  private recalculate(): void {
    this.pruneOld()

    let comments = 0
    let total = 0
    for (const e of this.events) {
      total++
      if (e.type === 'comment') comments++
    }

    const newTemp = this.classify(comments, total)

    // Hysteresis: must see same new temperature twice before switching
    if (newTemp !== this.current) {
      if (this.pending === newTemp) {
        // Confirmed: switch
        const old = this.current
        this.current = newTemp
        this.pending = null
        console.log(`[RoomTemperature] ${old} → ${newTemp} (comments/min: ${comments}, total/min: ${total})`)
        this.broadcast()
      } else {
        this.pending = newTemp
      }
    } else {
      this.pending = null
    }
  }

  private classify(comments: number, total: number): RoomTemperature {
    if (comments > 30 || total > 50) return 'fire'
    if (comments > 10 || total > 20) return 'hot'
    if (comments >= 2 || total >= 5) return 'warm'
    return 'cold'
  }

  private broadcast(): void {
    const snapshot = this.getSnapshot()
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
        win.webContents.send('live:temperature-update', snapshot)
      }
    }
  }
}

export const roomTemperatureService = new RoomTemperatureService()
