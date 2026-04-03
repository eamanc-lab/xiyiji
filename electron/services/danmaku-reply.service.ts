import { EventEmitter } from 'events'
import { danmakuService, DanmakuMessage } from './danmaku.service'
import { buildFuzzyPattern } from './event-batcher'
import { roomTemperatureService, type RoomTemperature } from './room-temperature'

// Purchase-intent keywords for high-value comment detection
const PURCHASE_KEYWORDS = [
  '多少钱', '怎么买', '有货吗', '价格', '下单', '链接',
  '几号链接', '拍了', '想买', '能便宜', '优惠', '库存',
  '发货', '包邮', '尺码', '颜色', '款式', '同款'
]

/**
 * Pure filter service for danmaku auto-reply.
 * No longer performs LLM/TTS — instead routes high-value danmaku
 * to aiLoopService as priority replies for unified generation.
 */
class DanmakuReplyService extends EventEmitter {
  private enabled = false
  private cooldownMs = 5000
  private lastReplyTime = 0
  private recentTexts: string[] = []
  private forbiddenPatterns: RegExp[] = []
  private blacklistedUids: Set<string> = new Set()
  private _addPriorityReply: ((item: { nickname: string; content: string; timestamp: number }) => void) | null = null

  /** Inject aiLoopService.addPriorityReply to avoid circular dependency */
  setAiLoopBridge(fn: (item: { nickname: string; content: string; timestamp: number }) => void): void {
    this._addPriorityReply = fn
  }

  constructor() {
    super()
    // Listen for Bilibili danmaku messages
    danmakuService.on('danmaku', (msg: DanmakuMessage) => {
      if (this.enabled) {
        this.onDanmaku(msg)
      }
    })
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    this.emit('enabled-change', enabled)
  }

  isEnabled(): boolean {
    return this.enabled
  }

  setCooldown(ms: number): void {
    this.cooldownMs = ms
  }

  setForbiddenWords(words: string[]): void {
    this.forbiddenPatterns = words
      .map(w => w.trim())
      .filter(w => w.length > 0)
      .map(buildFuzzyPattern)
  }

  setBlacklist(userIds: string[]): void {
    this.blacklistedUids = new Set(userIds)
  }

  addToBlacklist(userId: string): void {
    this.blacklistedUids.add(userId)
  }

  /**
   * Process an externally-received danmaku message (from platform adapters like TikTok/Douyin).
   * Same filtering logic as Bilibili danmaku.
   */
  receiveDanmaku(msg: DanmakuMessage): void {
    if (this.enabled) {
      this.onDanmaku(msg)
    }
  }

  private onDanmaku(msg: DanmakuMessage): void {
    const text = (msg.text || '').trim()
    if (!text) return

    // Filter: blacklisted user
    if (this.blacklistedUids.has(String(msg.uid))) return

    // Filter: forbidden words (fuzzy match)
    if (this.forbiddenPatterns.some(p => p.test(text))) return

    // Filter: duplicate (same text in recent 10)
    if (this.recentTexts.includes(text)) return

    // Track recent texts for dedup
    this.recentTexts.push(text)
    if (this.recentTexts.length > 10) this.recentTexts.shift()

    // Get current temperature for adaptive behavior
    const temperature = roomTemperatureService.getTemperature()

    // Adaptive cooldown based on temperature
    const adaptiveCooldown = this.getAdaptiveCooldown(temperature)
    const now = Date.now()
    if (now - this.lastReplyTime < adaptiveCooldown) return

    // Temperature-aware reply decision
    if (!this.shouldReply(text, temperature)) return

    // Route to aiLoopService as priority reply (injected via setAiLoopBridge to avoid circular dependency)
    if (this._addPriorityReply) {
      this._addPriorityReply({
        nickname: msg.username || '',
        content: text,
        timestamp: msg.timestamp || Date.now()
      })
    }

    this.lastReplyTime = now
  }

  /**
   * Temperature-aware reply decision.
   * - cold/warm: reply to all comments that pass basic filtering
   * - hot: only reply to high-value comments
   * - fire: only reply to 30% of high-value comments
   */
  private shouldReply(text: string, temperature: RoomTemperature): boolean {
    if (temperature === 'cold' || temperature === 'warm') {
      return true
    }

    const highValue = this.isHighValueComment(text)
    if (temperature === 'hot') {
      return highValue
    }

    // fire: 30% of high-value
    if (temperature === 'fire') {
      return highValue && Math.random() < 0.3
    }

    return true
  }

  /**
   * Detect high-value comments: questions, purchase intent, longer messages.
   */
  private isHighValueComment(text: string): boolean {
    // Contains question mark
    if (text.includes('?') || text.includes('？')) return true

    // Contains purchase-intent keywords
    const lower = text.toLowerCase()
    if (PURCHASE_KEYWORDS.some(kw => lower.includes(kw))) return true

    // Longer messages tend to be more substantive
    if (text.length > 15) return true

    return false
  }

  /**
   * Adaptive cooldown based on room temperature.
   * Hot rooms need longer cooldowns to avoid overwhelming the generation queue.
   */
  private getAdaptiveCooldown(temperature: RoomTemperature): number {
    switch (temperature) {
      case 'cold':  return 2_000
      case 'warm':  return 5_000
      case 'hot':   return 10_000
      case 'fire':  return 15_000
      default:      return this.cooldownMs
    }
  }
}

export const danmakuReplyService = new DanmakuReplyService()
