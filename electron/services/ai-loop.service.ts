import { BrowserWindow } from 'electron'
import { qwenService } from './qwen.service'
import { orderedGeneralizeService } from './ordered-generalize.service'
import { queueManager, type PlaylistItemMeta } from './queue.manager'
import { roomSessionService } from './room-session.service'
import { ttsService } from './tts.service'
import { liveTranslationService } from './live-translation.service'
import { roomTemperatureService, type RoomTemperature } from './room-temperature'
import { dbGet } from '../db/index'
import type { DanmakuEvent } from './event-batcher'

function parseIntEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = (process.env[name] || '').trim()
  if (!raw) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.floor(n)))
}

const TICK_INTERVAL_MS = parseIntEnv('AI_LOOP_TICK_MS', 1_000, 200, 10_000)
const FALLBACK_BATCH_SIZE = 5  // number of fallback lines per refill
const ORDERED_GENERALIZE_BATCH_SIZE = parseIntEnv('AI_ORDERED_GENERALIZE_BATCH_SIZE', 3, 1, 10)
const TOTAL_REFILL_THRESHOLD = parseIntEnv('AI_TOTAL_REFILL_THRESHOLD', 3, 1, 40)
const REFILL_DEBOUNCE_MS = parseIntEnv('AI_REFILL_DEBOUNCE_MS', 150, 20, 1000)

interface FallbackState {
  signature: string
  lines: GeneratedLine[]
  idx: number
}

interface RotationState {
  enabled: boolean
  batchesPerProduct: number           // batches per product before advancing (default 1)
  currentIndex: number                // index into sortedLinkIds
  batchesCompleted: number            // batches generated for current product
  sortedLinkIds: string[]             // snapshot of link IDs sorted by slot_no
  interruptedFromIndex: number | null // saved position when interrupted by danmaku
  interruptLinkId: string | null      // the product we interrupted to
  interruptBatchesDone: number        // batches done for the interrupt product
  interruptPendingFirstBatch: boolean // true when interrupt happened during active generate()
}

export interface RotationUpdate {
  enabled: boolean
  currentLinkId: string | null
  isInterrupted: boolean
  interruptedBy?: string
  batchProgress: number
  batchTotal: number
}

interface GeneratedLine {
  text: string
  translatedText?: string | null
  meta?: PlaylistItemMeta | null
}

/**
 * AI-driven loop: periodically checks if queue needs replenishment,
 * then calls Qwen for a BATCH of 10-15 scripts with full context,
 * and submits TTS for each line.
 *
 * Also manages auto-rotation: cycling through product links automatically,
 * with danmaku-triggered interruptions.
 */
class AiLoopService {
  private activeRoomId: string | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private refillTimer: ReturnType<typeof setTimeout> | null = null
  private generating = false // prevent concurrent generation

  // Pending danmaku events (added by eventBatcher callback)
  private pendingEvents: DanmakuEvent[] = []

  // Priority reply queue (from danmakuReplyService filter)
  private priorityQueue: Array<{ nickname: string; content: string; timestamp: number }> = []

  // Gift accumulator (collected from batched events)
  private giftAccumulator: Array<{ nickname: string; giftName: string; count: number; timestamp: number }> = []

  // Danmaku-triggered generation state
  private danmakuResponseCooldownUntil = 0
  private danmakuTriggered = false
  private static readonly DANMAKU_RESPONSE_COOLDOWN_MS = 8_000

  // Fallback states per script source (general / active link)
  private fallbackStates = new Map<string, FallbackState>()

  // Auto-rotation state
  private rotation: RotationState = {
    enabled: false,
    batchesPerProduct: 1,
    currentIndex: 0,
    batchesCompleted: 0,
    sortedLinkIds: [],
    interruptedFromIndex: null,
    interruptLinkId: null,
    interruptBatchesDone: 0,
    interruptPendingFirstBatch: false
  }

  private readonly onQueueChanged = (): void => {
    this.requestRefill('queue-changed')
  }

  start(roomId: string): void {
    this.stop()
    this.activeRoomId = roomId
    this.prepareFallback(roomId).catch(err => {
      console.error('[AiLoop] prepareFallback failed:', err.message)
    })
    this.timer = setInterval(() => this.tick(), TICK_INTERVAL_MS)
    queueManager.on('changed', this.onQueueChanged)
    this.requestRefill('start')
    console.log(`[AiLoop] Started for room: ${roomId}`)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.refillTimer) {
      clearTimeout(this.refillTimer)
      this.refillTimer = null
    }
    queueManager.removeListener('changed', this.onQueueChanged)
    this.pendingEvents = []
    this.priorityQueue = []
    this.giftAccumulator = []
    this.generating = false
    this.danmakuResponseCooldownUntil = 0
    this.danmakuTriggered = false
    this.fallbackStates.clear()
    this.activeRoomId = null
    this.disableAutoRotation()
    console.log('[AiLoop] Stopped')
  }

  /** Called by eventBatcher when a batch of danmaku arrives. */
  receiveBatch(events: DanmakuEvent[]): void {
    // Separate gift events into accumulator
    for (const e of events) {
      if (e.type === 'gift') {
        this.giftAccumulator.push({
          nickname: e.nickname,
          giftName: e.content,
          count: 1,
          timestamp: e.timestamp
        })
      }
    }
    // Cap gift accumulator at 50
    if (this.giftAccumulator.length > 50) {
      this.giftAccumulator = this.giftAccumulator.slice(-50)
    }

    this.pendingEvents.push(...events)
    if (this.pendingEvents.length > 20) {
      this.pendingEvents = this.pendingEvents.slice(-20)
    }
    // Check for product mentions that should interrupt rotation
    this.checkDanmakuForProductMention(events)

    // Trigger immediate generation when comments arrive (bypass shouldRefill)
    const hasComments = events.some(e => e.type === 'comment')
    if (hasComments) {
      this.requestDanmakuResponse()
    }
  }

  /**
   * Request an immediate danmaku-aware generation cycle.
   * Bypasses shouldRefill() — generates even when queue is full.
   * Has its own 8-second cooldown to avoid Qwen API spam.
   */
  private requestDanmakuResponse(): void {
    if (!this.activeRoomId) return
    if (this.generating) return
    const now = Date.now()
    if (now < this.danmakuResponseCooldownUntil) return

    const aiMode = roomSessionService.getAiSettings(this.activeRoomId).aiMode
    this.danmakuResponseCooldownUntil = now + AiLoopService.DANMAKU_RESPONSE_COOLDOWN_MS
    this.danmakuTriggered = true

    this.prepareQueueForInteraction(aiMode)

    console.log(`[AiLoop] Danmaku response triggered (mode=${aiMode})`)
    void this.generate(this.activeRoomId)
  }

  /**
   * Add a priority reply item (from danmakuReplyService filter).
   * If not currently generating, triggers immediate generation.
   */
  addPriorityReply(item: { nickname: string; content: string; timestamp: number }): void {
    if (this.priorityQueue.length >= 10) {
      this.priorityQueue.shift() // drop oldest
    }
    this.priorityQueue.push(item)
    console.log(`[AiLoop] Priority reply queued: "${item.nickname}: ${item.content}"`)

    // Trigger immediate generation — shares cooldown with requestDanmakuResponse
    if (!this.generating && this.activeRoomId) {
      const now = Date.now()
      if (now < this.danmakuResponseCooldownUntil) return

      const aiMode = roomSessionService.getAiSettings(this.activeRoomId).aiMode
      this.danmakuResponseCooldownUntil = now + AiLoopService.DANMAKU_RESPONSE_COOLDOWN_MS
      this.danmakuTriggered = true
      this.prepareQueueForInteraction(aiMode)

      console.log(`[AiLoop] Priority danmaku response triggered (mode=${aiMode})`)
      void this.generate(this.activeRoomId)
    }
  }

  /** Trigger immediately (e.g., on link switch). */
  async triggerNow(): Promise<void> {
    if (!this.activeRoomId) return
    await this.generate(this.activeRoomId)
  }

  // ── Auto-rotation public API ──────────────────────────────────────

  enableAutoRotation(batchesPerProduct: number = 1): void {
    if (!this.activeRoomId) return

    const sorted = roomSessionService.getSortedLinkIds(this.activeRoomId)
    if (sorted.length < 2) {
      console.log('[AiLoop] Auto-rotation requires at least 2 links, not enabling')
      return
    }

    this.rotation = {
      enabled: true,
      batchesPerProduct: Math.max(1, batchesPerProduct),
      currentIndex: 0,
      batchesCompleted: 0,
      sortedLinkIds: sorted,
      interruptedFromIndex: null,
      interruptLinkId: null,
      interruptBatchesDone: 0,
      interruptPendingFirstBatch: false
    }

    // Switch to the first product
    const firstLinkId = sorted[0]
    roomSessionService.switchLink(this.activeRoomId, firstLinkId)
    this.sendRotationUpdate()

    console.log(`[AiLoop] Auto-rotation enabled: ${sorted.length} links, ${batchesPerProduct} batch(es)/product`)

    // Trigger immediate generation
    this.triggerNow().catch(console.error)
  }

  disableAutoRotation(): void {
    if (!this.rotation.enabled) return
    this.rotation = {
      enabled: false,
      batchesPerProduct: 1,
      currentIndex: 0,
      batchesCompleted: 0,
      sortedLinkIds: [],
      interruptedFromIndex: null,
      interruptLinkId: null,
      interruptBatchesDone: 0,
      interruptPendingFirstBatch: false
    }
    this.sendRotationUpdate()
    console.log('[AiLoop] Auto-rotation disabled')
  }

  getRotationState(): RotationUpdate {
    const r = this.rotation
    let currentLinkId: string | null = null
    if (r.enabled) {
      currentLinkId = r.interruptedFromIndex !== null
        ? r.interruptLinkId
        : r.sortedLinkIds[r.currentIndex] ?? null
    }
    return {
      enabled: r.enabled,
      currentLinkId,
      isInterrupted: r.interruptedFromIndex !== null,
      batchProgress: r.interruptedFromIndex !== null
        ? r.interruptBatchesDone + 1
        : r.batchesCompleted + 1,
      batchTotal: r.batchesPerProduct
    }
  }

  // ── Private: generation ───────────────────────────────────────────

  private async tick(): Promise<void> {
    this.requestRefill('tick')
  }

  private shouldRefill(): boolean {
    // Use total (pending + ready) count only.
    // Previous OR logic (ready < X || total < Y) caused startup flooding:
    // TTS-pending items had ready=0, triggering 4 consecutive batches (20 items).
    const total = queueManager.getPendingCount()
    return total < TOTAL_REFILL_THRESHOLD
  }

  private requestRefill(reason: string): void {
    if (!this.activeRoomId) return
    if (this.generating) return
    if (!this.shouldRefill()) return
    if (this.refillTimer) return

    this.refillTimer = setTimeout(() => {
      this.refillTimer = null
      if (!this.activeRoomId) return
      if (this.generating) return
      if (!this.shouldRefill()) return
      void this.generate(this.activeRoomId)
    }, REFILL_DEBOUNCE_MS)

    if (reason === 'start') {
      console.log(
        `[AiLoop] Refill trigger: reason=${reason}, ready=${queueManager.getReadyCount()}, pending=${queueManager.getPendingCount()}`
      )
    }
  }

  private buildQueueMeta(
    role: NonNullable<PlaylistItemMeta['role']>,
    aiMode: string,
    extra: Partial<PlaylistItemMeta> = {}
  ): PlaylistItemMeta {
    return {
      role,
      aiMode,
      scriptSourceKey: extra.scriptSourceKey ?? null,
      sequenceIndex: extra.sequenceIndex ?? null,
      sequenceTotal: extra.sequenceTotal ?? null,
      round: extra.round ?? null,
      preserveOrder: extra.preserveOrder ?? null
    }
  }

  private prepareQueueForInteraction(aiMode: string): void {
    if (aiMode === 'full_ai') {
      queueManager.dropPendingBy((item) => {
        const role = item.meta?.role
        return role === 'mainline' || role === 'interaction'
      })
      return
    }

    queueManager.dropPendingBy((item) => item.meta?.role === 'interaction')
  }

  clearPendingGenerated(): void {
    queueManager.dropPendingBy((item) => {
      const role = item.meta?.role
      return role === 'mainline' || role === 'interaction'
    })
  }

  private async getNextOrderedGeneralizeBatch(roomId: string): Promise<GeneratedLine[]> {
    const aiSettings = roomSessionService.getAiSettings(roomId)
    const lines = await orderedGeneralizeService.getNextBatch(
      roomId,
      ORDERED_GENERALIZE_BATCH_SIZE,
      aiSettings.outputLanguage
    )

    return lines.map((line) => ({
      text: line.text,
      translatedText: line.translatedText,
      meta: this.buildQueueMeta('mainline', aiSettings.aiMode, {
        scriptSourceKey: line.sourceKey,
        sequenceIndex: line.unitIndex + 1,
        sequenceTotal: line.unitTotal,
        round: line.round,
        preserveOrder: true
      })
    }))
  }

  private async generate(roomId: string): Promise<void> {
    if (this.generating) return
    this.generating = true

    try {
      const session = roomSessionService.getSession(roomId)
      if (!session) return

      const temperature = roomTemperatureService.getTemperature()

      // ① Drain priority queue, pending events, and gift accumulator
      const priorityItems = [...this.priorityQueue]
      this.priorityQueue = []
      const events = [...this.pendingEvents]
      this.pendingEvents = []
      const giftSummary = this.buildGiftSummary(temperature)

      // Capture and reset danmaku trigger flag
      const isDanmakuTrigger = this.danmakuTriggered
      this.danmakuTriggered = false

      const aiSettings = roomSessionService.getAiSettings(roomId)
      const { aiMode } = aiSettings

      // Dynamic batch size based on temperature
      const tempBatchSize = this.getTemperatureBatchSize(temperature)
      const hasInteractionSignal = events.length > 0 || priorityItems.length > 0

      let lines: GeneratedLine[] = []

      if (aiMode === 'ordered_generalize_ai' && !hasInteractionSignal) {
        lines = await this.getNextOrderedGeneralizeBatch(roomId)
      } else if ((aiMode === 'no_ai' || aiMode === 'semi_ai') && !hasInteractionSignal) {
        lines = await this.getNextFallbackBatch(roomId, FALLBACK_BATCH_SIZE, aiMode)
      } else {
        // ② De-duplicate: remove priority danmaku from regular events
        const priorityTexts = new Set(priorityItems.map(p => p.content))
        const filteredEvents = events.filter(e => !priorityTexts.has(e.content))

        // ③ Format danmaku strings
        const danmakuStrings = filteredEvents.map(e => {
          if (e.type === 'comment') return `${e.nickname}: ${e.content}`
          if (e.type === 'gift') return `${e.nickname} 送出礼物: ${e.content}`
          if (e.type === 'follow') return `${e.nickname} 关注了`
          return `${e.nickname} 进入直播间`
        })

        const priorityStrings = priorityItems.map(p => `★ ${p.nickname}: ${p.content}`)

        // ④ Build BatchContext with temperature fields
        const currentPlaying = queueManager.getCurrentlyPlaying()
        const ctx = roomSessionService.buildBatchContext(
          roomId,
          danmakuStrings,
          currentPlaying?.text || ''
        )

        if (ctx) {
          ctx.temperature = temperature
          ctx.temperatureHint = this.getTemperatureHint(temperature)
          ctx.giftSummary = giftSummary
          ctx.priorityDanmaku = priorityStrings
          ctx.batchSize = tempBatchSize

          // ⑤ Shrink batchSize when priority replies present
          if (priorityStrings.length > 0) {
            ctx.batchSize = Math.min(ctx.batchSize, 3 + priorityStrings.length)
          }

          // ⑤b Danmaku-triggered: use focused danmaku response prompt (2 lines only)
          if (isDanmakuTrigger && events.some(e => e.type === 'comment')) {
            ctx.batchSize = 2
            ctx.isDanmakuResponse = true
          }

          lines = (await qwenService.generateBatch(ctx)).map((text) => ({
            text,
            meta: this.buildQueueMeta('mainline', aiMode)
          }))
        }

        if (lines.length === 0) {
          console.log('[AiLoop] LLM returned empty, using fallback scripts')
          lines = await this.getNextFallbackBatch(roomId, FALLBACK_BATCH_SIZE, aiMode)
        }
      }

      if (lines.length === 0) return

      console.log(`[AiLoop] Generated batch: ${lines.length} items (mode: ${aiMode}, temp: ${temperature})`)

      // ⑥ Submit to queue — danmaku/priority lines use insertAfterCurrent
      const hasCommentEvents = events.some(e => e.type === 'comment')
      if (isDanmakuTrigger && hasCommentEvents) {
        // Danmaku-triggered: all lines are danmaku responses, insert as priority
        await this.submitPriority(roomId, lines)
      } else if (priorityItems.length > 0 && lines.length > 0) {
        const priorityCount = Math.min(3, lines.length)
        const priorityLines = lines.slice(0, priorityCount)
        const normalLines = lines.slice(priorityCount)

        await this.submitPriority(roomId, priorityLines)
        if (normalLines.length > 0) {
          await this.submitBatch(roomId, normalLines)
        }
      } else {
        await this.submitBatch(roomId, lines)
      }

      // ⑦ Advance auto-rotation after successful batch
      if (this.rotation.enabled) {
        this.advanceRotation(roomId)
      }
    } catch (err: any) {
      console.error('[AiLoop] generate() error:', err.message)
    } finally {
      this.generating = false
      this.requestRefill('post-generate')
    }
  }

  /**
   * Push all lines into the queue and fire TTS for each one.
   */
  private async submitBatch(roomId: string, lines: GeneratedLine[]): Promise<void> {
    const profile = dbGet(`
      SELECT p.tts_voice, p.tts_speed
      FROM rooms r
      LEFT JOIN dh_profiles p ON p.id = r.profile_id
      WHERE r.id = ?
    `, [roomId])

    const voice = (profile?.tts_voice as string) || 'jack_cheng'
    const speed = (profile?.tts_speed as number) || 1.0
    const outputLanguage = roomSessionService.getAiSettings(roomId).outputLanguage

    const items = queueManager.pushBatch(
      lines.map(({ text, translatedText, meta }) => ({
        text,
        translatedText: translatedText ?? null,
        audioPath: null,
        source: 'ai' as const,
        meta: meta ?? this.buildQueueMeta('mainline', roomSessionService.getAiSettings(roomId).aiMode)
      }))
    )

    this.fillMissingChineseTranslations(outputLanguage, items.map((item, index) => ({
      id: item.id,
      line: lines[index]
    })))

    for (const item of items) {
      ttsService.synthesize(voice, item.text, speed)
        .then(result => {
          queueManager.updateAudioPath(item.id, result.audioPath)
        })
        .catch(err => {
          queueManager.dropPendingItem(item.id, err.message)
          console.error(`[AiLoop] TTS failed for item ${item.id}:`, err.message)
        })
    }

    for (const line of lines.slice(0, 3)) {
      roomSessionService.recordResponse(roomId, line.text)
    }
  }

  /**
   * Submit priority lines using insertAfterCurrent for immediate playback.
   */
  private async submitPriority(roomId: string, lines: GeneratedLine[]): Promise<void> {
    const profile = dbGet(`
      SELECT p.tts_voice, p.tts_speed
      FROM rooms r
      LEFT JOIN dh_profiles p ON p.id = r.profile_id
      WHERE r.id = ?
    `, [roomId])

    const voice = (profile?.tts_voice as string) || 'jack_cheng'
    const baseSpeed = (profile?.tts_speed as number) || 1.0
    const speed = Math.min(baseSpeed * 1.1, 2.0)
    const aiSettings = roomSessionService.getAiSettings(roomId)
    const outputLanguage = aiSettings.outputLanguage
    const inserted: Array<{ id: string; line: GeneratedLine }> = []

    for (const line of lines) {
      const item = queueManager.insertAfterCurrent({
        text: line.text,
        translatedText: line.translatedText ?? null,
        audioPath: null,
        source: 'manual',
        meta: this.buildQueueMeta('interaction', line.meta?.aiMode || aiSettings.aiMode)
      })
      inserted.push({ id: item.id, line })

      ttsService.synthesize(voice, line.text, speed)
        .then(result => {
          queueManager.updateAudioPath(item.id, result.audioPath)
        })
        .catch(err => {
          queueManager.dropPendingItem(item.id, err.message)
          console.error(`[AiLoop] Priority TTS failed for item ${item.id}:`, err.message)
        })
    }

    this.fillMissingChineseTranslations(outputLanguage, inserted)

    for (const line of lines.slice(0, 2)) {
      roomSessionService.recordResponse(roomId, line.text)
    }
  }

  private fillMissingChineseTranslations(
    outputLanguage: string,
    items: Array<{ id: string; line: GeneratedLine }>
  ): void {
    if (outputLanguage === 'zh-CN') return

    const missing = items.filter(({ line }) => !line.translatedText && line.text.trim().length > 0)
    if (missing.length === 0) return

    liveTranslationService.translateLines(
      missing.map(({ line }) => line.text),
      'zh-CN'
    )
      .then((translated) => {
        const updates = missing
          .map((entry, index) => ({
            id: entry.id,
            translatedText: this.normalizeChineseTranslation(entry.line.text, translated[index])
          }))
          .filter((entry) => entry.translatedText !== null)

        if (updates.length > 0) {
          queueManager.updateTranslations(updates)
        }
      })
      .catch((err: any) => {
        console.error('[AiLoop] Chinese translation failed:', err.message)
      })
  }

  private normalizeChineseTranslation(sourceText: string, translatedText: string | null | undefined): string | null {
    const source = String(sourceText || '').trim()
    const translated = String(translatedText || '').trim()

    if (!translated) return null
    if (translated === source) return null
    return /[\u4e00-\u9fff]/.test(translated) ? translated : null
  }

  /**
   * Build a gift summary string from accumulated gift events.
   * In cold/warm: list each gift individually. In hot/fire: aggregate summary.
   */
  private buildGiftSummary(temperature: RoomTemperature): string {
    if (this.giftAccumulator.length === 0) return ''

    const gifts = [...this.giftAccumulator]
    this.giftAccumulator = []

    if (temperature === 'cold' || temperature === 'warm') {
      // Individual thanks
      const parts = gifts.slice(0, 5).map(g =>
        g.giftName ? `${g.nickname}送了${g.giftName}` : `${g.nickname}送了礼物`
      )
      if (gifts.length > 5) {
        parts.push(`等共${gifts.length}位朋友`)
      }
      return parts.join('，')
    } else {
      // Aggregate summary for hot/fire
      const uniqueUsers = new Set(gifts.map(g => g.nickname))
      const giftNames = new Map<string, number>()
      for (const g of gifts) {
        const name = g.giftName || '礼物'
        giftNames.set(name, (giftNames.get(name) || 0) + g.count)
      }
      const giftParts = Array.from(giftNames.entries())
        .slice(0, 3)
        .map(([name, count]) => `${name}x${count}`)
        .join('、')
      return `最近收到${uniqueUsers.size}位朋友的礼物（${giftParts}）`
    }
  }

  private getTemperatureHint(temperature: RoomTemperature): string {
    switch (temperature) {
      case 'cold':
        return '直播间比较安静。用轻松聊天的语气，内容详细深入，可以讲产品故事和细节。适当加入互动引导（"有喜欢的朋友扣个1"）。'
      case 'warm':
        return '直播间有一些互动。保持自然对话节奏，产品介绍和互动穿插进行。'
      case 'hot':
        return '直播间很热闹，弹幕较多。语气更有感染力，重点回应有价值的提问，礼物批量感谢。'
      case 'fire':
        return '直播间超级火爆！保持高能状态，简短有力。多用互动语气（"没错！""对对对"）。穿插核心卖点。'
      default:
        return ''
    }
  }

  private getTemperatureBatchSize(temperature: RoomTemperature): number {
    switch (temperature) {
      case 'cold':  return 5
      case 'warm':  return 8
      case 'hot':   return 12
      case 'fire':  return 6
      default:      return 8
    }
  }

  // ── Private: auto-rotation ────────────────────────────────────────

  private advanceRotation(roomId: string): void {
    const r = this.rotation
    if (!r.enabled) return

    if (r.interruptedFromIndex !== null) {
      // If interrupt happened during an active generate(), the first batch completing
      // is still the OLD product's content — skip counting it
      if (r.interruptPendingFirstBatch) {
        r.interruptPendingFirstBatch = false
        this.sendRotationUpdate()
        return
      }

      // INTERRUPTED state: count batches for interrupt product
      r.interruptBatchesDone++
      if (r.interruptBatchesDone >= 1) {
        // Resume rotation from where we were
        r.currentIndex = r.interruptedFromIndex
        r.interruptedFromIndex = null
        r.interruptLinkId = null
        r.interruptBatchesDone = 0
        r.batchesCompleted = 0

        // Guard: link may have been removed
        if (r.currentIndex >= r.sortedLinkIds.length) {
          r.currentIndex = 0
        }

        const linkId = r.sortedLinkIds[r.currentIndex]
        roomSessionService.switchLink(roomId, linkId)
        this.sendRotationUpdate()
        console.log(`[AiLoop] Auto-rotation: resumed to link ${r.currentIndex + 1}/${r.sortedLinkIds.length}`)
      }
    } else {
      // ROTATING state: count batches for current product
      r.batchesCompleted++
      if (r.batchesCompleted >= r.batchesPerProduct) {
        // Advance to next product
        r.currentIndex = (r.currentIndex + 1) % r.sortedLinkIds.length
        r.batchesCompleted = 0

        const linkId = r.sortedLinkIds[r.currentIndex]
        roomSessionService.switchLink(roomId, linkId)
        this.sendRotationUpdate()
        console.log(`[AiLoop] Auto-rotation: switched to link ${r.currentIndex + 1}/${r.sortedLinkIds.length}`)
      }
    }
  }

  private checkDanmakuForProductMention(events: DanmakuEvent[]): void {
    const r = this.rotation
    if (!r.enabled || !this.activeRoomId) return

    // Only process in ROTATING state (not already interrupted)
    if (r.interruptedFromIndex !== null) return

    const nameMap = roomSessionService.getLinkNameMap(this.activeRoomId)
    if (nameMap.size === 0) return

    // Current link being rotated
    const currentLinkId = r.sortedLinkIds[r.currentIndex]

    // Build candidates: links other than the current one, with non-empty names
    const candidates: Array<{ linkId: string; name: string }> = []
    for (const [linkId, name] of nameMap) {
      if (linkId !== currentLinkId && name.trim().length >= 2) {
        candidates.push({ linkId, name })
      }
    }
    if (candidates.length === 0) return

    for (const event of events) {
      if (event.type !== 'comment') continue
      const content = event.content.toLowerCase()

      for (const candidate of candidates) {
        if (content.includes(candidate.name.toLowerCase())) {
          console.log(
            `[AiLoop] Danmaku interrupt: "${event.nickname}" mentioned "${candidate.name}"`
          )

          // Transition to INTERRUPTED state
          r.interruptedFromIndex = r.currentIndex
          r.interruptLinkId = candidate.linkId
          r.interruptBatchesDone = 0
          r.interruptPendingFirstBatch = this.generating // if generate() is running, its batch is old content

          // Switch to the mentioned product
          roomSessionService.switchLink(this.activeRoomId, candidate.linkId)
          this.sendRotationUpdate(event.nickname)

          // Trigger immediate generation
          this.triggerNow().catch(console.error)
          return // only process first match
        }
      }
    }
  }

  private sendRotationUpdate(interruptedBy?: string): void {
    const state = this.getRotationState()
    if (interruptedBy) state.interruptedBy = interruptedBy

    // Send to all windows — only the main window's renderer listens for this event
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
        win.webContents.send('live:rotation-update', state)
      }
    }
  }

  // ── Private: fallback ─────────────────────────────────────────────

  private async prepareFallback(roomId: string): Promise<void> {
    const source = roomSessionService.getCurrentScriptSource(roomId)
    if (!source || !source.content.trim()) return
    await this.ensureFallbackState(roomId, source)
  }

  private async ensureFallbackState(roomId: string, source = roomSessionService.getCurrentScriptSource(roomId)): Promise<FallbackState | null> {
    if (!source || !source.content.trim()) return null

    const aiSettings = roomSessionService.getAiSettings(roomId)
    const stateKey = `${roomId}::${source.key}`
    const signature = `${source.key}::${aiSettings.outputLanguage}::${source.content}`
    const existing = this.fallbackStates.get(stateKey)
    if (existing && existing.signature === signature) {
      return existing
    }

    let rawLines = source.content
      .split(/\n{2,}/)
      .map((line) => line.trim())
      .filter(Boolean)

    if (rawLines.length < 3) {
      rawLines = source.content
        .split(/\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 10)
    }

    if (rawLines.length < 3) {
      rawLines = source.content
        .split(/[.!?\u3002\uFF01\uFF1F]+/)
        .map((line) => line.trim())
        .filter((line) => line.length > 10)
    }

    if (rawLines.length === 0) {
      return null
    }

    let lines: GeneratedLine[]
    if (aiSettings.outputLanguage !== 'zh-CN') {
      console.log(`[AiLoop] Pre-translating ${rawLines.length} fallback lines to ${aiSettings.outputLanguage} (${source.key})`)
      const translated = await liveTranslationService.translateLines(rawLines, aiSettings.outputLanguage)
      lines = translated.map((text, index) => ({
        text,
        translatedText: rawLines[index] || null
      }))
    } else {
      lines = rawLines.map((text) => ({ text, translatedText: null }))
    }

    const nextState: FallbackState = {
      signature,
      lines,
      idx: existing?.idx ?? 0
    }
    this.fallbackStates.set(stateKey, nextState)
    console.log(`[AiLoop] Prepared ${nextState.lines.length} fallback lines (${source.key})`)
    return nextState
  }

  private async getNextFallbackBatch(roomId: string, count: number, aiMode: string): Promise<GeneratedLine[]> {
    const source = roomSessionService.getCurrentScriptSource(roomId)
    const state = await this.ensureFallbackState(roomId, source)
    if (!state || state.lines.length === 0 || !source) return []

    const result: GeneratedLine[] = []
    for (let i = 0; i < count; i++) {
      const line = state.lines[state.idx % state.lines.length]
      result.push({
        ...line,
        meta: this.buildQueueMeta('mainline', aiMode, {
          scriptSourceKey: source.key
        })
      })
      state.idx += 1
    }
    return result
  }
}

export const aiLoopService = new AiLoopService()
