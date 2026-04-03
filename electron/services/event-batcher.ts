import { roomTemperatureService } from './room-temperature'

export interface DanmakuEvent {
  userId: string
  nickname: string
  content: string
  type: 'comment' | 'gift' | 'follow' | 'enter'
  timestamp: number
}

export type BatchCallback = (events: DanmakuEvent[]) => void

/**
 * Build a regex that detects forbidden-word evasion by allowing up to 2
 * arbitrary characters between each consecutive pair of characters.
 * Example: pattern "淘宝" matches "淘某宝", "淘x宝" but not "淘xxxxx宝".
 */
export function buildFuzzyPattern(word: string): RegExp {
  const chars = [...word] // Unicode-safe split (handles CJK, emoji)
  const escaped = chars.map(ch => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(escaped.join('.{0,2}'), 'i')
}

/**
 * Collects danmaku events over a 4-second window, filters forbidden words
 * and blacklisted users, then fires the batch callback.
 */
export class EventBatcher {
  private batch: DanmakuEvent[] = []
  private forbiddenPatterns: RegExp[] = []
  private blacklistedIds: Set<string> = new Set()
  private timer: ReturnType<typeof setInterval> | null = null
  private callback: BatchCallback | null = null
  private immediateCallback: ((event: DanmakuEvent) => void) | null = null
  private intervalMs = 4_000

  setForbiddenWords(words: string[]): void {
    this.forbiddenPatterns = words
      .map(w => w.trim())
      .filter(w => w.length > 0)
      .map(buildFuzzyPattern)
  }

  setBlacklist(userIds: string[]): void {
    this.blacklistedIds = new Set(userIds)
  }

  addToBlacklist(userId: string): void {
    this.blacklistedIds.add(userId)
  }

  onBatch(callback: BatchCallback): void {
    this.callback = callback
  }

  /** Register a callback that fires IMMEDIATELY per comment event (no 4s delay). */
  onImmediate(callback: (event: DanmakuEvent) => void): void {
    this.immediateCallback = callback
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.flush(), this.intervalMs)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.batch = []
  }

  addEvent(event: DanmakuEvent): void {
    // Filter blacklisted users (all event types)
    if (this.blacklistedIds.has(event.userId)) return

    // Filter forbidden words via fuzzy regex (comments only)
    if (event.type === 'comment') {
      if (this.forbiddenPatterns.some(p => p.test(event.content))) return
    }

    this.batch.push(event)

    // Fire immediate callback for comment events (bypass 4s batch window)
    if (event.type === 'comment' && this.immediateCallback) {
      this.immediateCallback(event)
    }

    // Feed into room temperature tracking
    roomTemperatureService.recordEvent(event.type)
  }

  private flush(): void {
    if (this.batch.length === 0) return
    const toProcess = [...this.batch]
    this.batch = []
    this.callback?.(toProcess)
  }
}

export const eventBatcher = new EventBatcher()
