import { EventEmitter } from 'events'
import { v4 as uuidv4 } from 'uuid'

export interface PlaylistItemMeta {
  role?: 'mainline' | 'interaction' | 'manual' | 'shortcut'
  aiMode?: string | null
  scriptSourceKey?: string | null
  sequenceIndex?: number | null
  sequenceTotal?: number | null
  round?: number | null
  preserveOrder?: boolean | null
}

export interface PlaylistItem {
  id: string
  text: string
  translatedText?: string | null
  audioPath: string | null   // null = TTS still pending
  source: 'ai' | 'shortcut' | 'manual'
  meta?: PlaylistItemMeta | null
  status: 'pending' | 'ready' | 'playing' | 'buffered' | 'done' | 'dropped'
  insertedAt: number         // ms timestamp for staleness check
}

/**
 * Manages the live-broadcast playback queue.
 *
 * Key behaviours:
 * - next(): skips over TTS-pending items (moves them after the first ready item)
 * - dropStale(): drops items that have been pending/ready > 30 s
 * - updateAudioPath(): called by TTS when audio is ready; flips status to 'ready'
 */
export class QueueManager extends EventEmitter {
  private items: PlaylistItem[] = []
  private staleMs = 120_000
  private staleTimer: ReturnType<typeof setInterval> | null = null

  private isActiveItem(item: PlaylistItem): boolean {
    return item.status !== 'done' &&
      item.status !== 'dropped' &&
      item.status !== 'playing' &&
      item.status !== 'buffered'
  }

  private isStrictOrderedItem(item: PlaylistItem | null | undefined): boolean {
    return item?.meta?.preserveOrder === true ||
      (item?.meta?.role === 'mainline' && item?.meta?.aiMode === 'ordered_generalize_ai')
  }

  start(): void {
    if (this.staleTimer) return
    this.staleTimer = setInterval(() => this.dropStale(), 5_000)
  }

  stop(): void {
    if (this.staleTimer) {
      clearInterval(this.staleTimer)
      this.staleTimer = null
    }
  }

  /** Append item to end of queue. */
  push(item: Omit<PlaylistItem, 'id' | 'insertedAt' | 'status'>): PlaylistItem {
    const newItem: PlaylistItem = {
      ...item,
      translatedText: item.translatedText ?? null,
      meta: item.meta ?? null,
      id: uuidv4(),
      insertedAt: Date.now(),
      status: item.audioPath !== null ? 'ready' : 'pending'
    }
    this.items.push(newItem)
    this.emit('changed', this.getQueue())
    return newItem
  }

  /** Append multiple items to end of queue in one batch (single 'changed' event). */
  pushBatch(items: Array<Omit<PlaylistItem, 'id' | 'insertedAt' | 'status'>>): PlaylistItem[] {
    const now = Date.now()
    const newItems: PlaylistItem[] = items.map(item => ({
      ...item,
      translatedText: item.translatedText ?? null,
      meta: item.meta ?? null,
      id: uuidv4(),
      insertedAt: now,
      status: (item.audioPath !== null ? 'ready' : 'pending') as PlaylistItem['status']
    }))
    this.items.push(...newItems)
    this.emit('changed', this.getQueue())
    console.log(`[Queue] Batch pushed: ${newItems.length} items`)
    return newItems
  }

  /** Insert item immediately after the currently-playing item (high-priority). */
  insertAfterCurrent(item: Omit<PlaylistItem, 'id' | 'insertedAt' | 'status'>): PlaylistItem {
    const newItem: PlaylistItem = {
      ...item,
      translatedText: item.translatedText ?? null,
      meta: item.meta ?? null,
      id: uuidv4(),
      insertedAt: Date.now(),
      status: item.audioPath !== null ? 'ready' : 'pending'
    }
    // Insert after the active item: prefer 'playing' (being processed), fall back to 'buffered' (being heard)
    const playingIdx = this.items.findIndex(i => i.status === 'playing')
    const bufferedIdx = this.items.findIndex(i => i.status === 'buffered')
    const activeIdx = playingIdx !== -1 ? playingIdx : bufferedIdx
    if (activeIdx !== -1) {
      this.items.splice(activeIdx + 1, 0, newItem)
    } else {
      const firstActive = this.items.findIndex(i => i.status !== 'done' && i.status !== 'dropped')
      if (firstActive !== -1) {
        this.items.splice(firstActive, 0, newItem)
      } else {
        this.items.push(newItem)
      }
    }
    this.emit('changed', this.getQueue())
    return newItem
  }

  /**
   * Dequeue the next ready item.
   * Any pending items that come BEFORE the first ready item are moved to
   * just after it (so they are not lost, just reordered).
   */
  next(): PlaylistItem | null {
    const active = this.items.filter((item) => this.isActiveItem(item))
    if (active.length === 0) return null

    const firstActive = this.items.find((item) => this.isActiveItem(item)) || null
    if (this.isStrictOrderedItem(firstActive)) {
      if (!firstActive || firstActive.status !== 'ready' || firstActive.audioPath === null) {
        return null
      }
      firstActive.status = 'playing'
      this.emit('changed', this.getQueue())
      return firstActive
    }

    const firstReady = active.find(i => i.status === 'ready' && i.audioPath !== null)
    if (!firstReady) return null

    const firstReadyGlobalIdx = this.items.indexOf(firstReady)

    // Collect pending items that are BEFORE firstReady globally
    const toMove = this.items.filter((item, idx) => {
      return idx < firstReadyGlobalIdx &&
        this.isActiveItem(item) &&
        !this.isStrictOrderedItem(item)
    })

    if (toMove.length > 0) {
      const idSet = new Set(toMove.map(i => i.id))
      this.items = this.items.filter(i => !idSet.has(i.id))
      const newReadyIdx = this.items.indexOf(firstReady)
      this.items.splice(newReadyIdx + 1, 0, ...toMove)
    }

    firstReady.status = 'playing'
    this.emit('changed', this.getQueue())
    return firstReady
  }

  /** Mark currently-playing item as done. */
  markCurrentDone(): void {
    const playing = this.items.find(i => i.status === 'playing')
    if (playing) {
      playing.status = 'done'
      this.emit('changed', this.getQueue())
    }
  }

  /** Transition playing → buffered (F2F done, player still playing audio). */
  markCurrentBuffered(): void {
    const playing = this.items.find(i => i.status === 'playing')
    if (playing) {
      playing.status = 'buffered'
      this.emit('changed', this.getQueue())
    }
  }

  /** Transition a specific buffered item → done by ID (called by timer). */
  markDoneById(id: string): void {
    const item = this.items.find(i => i.id === id && i.status === 'buffered')
    if (item) {
      item.status = 'done'
      this.emit('changed', this.getQueue())
    }
  }

  /** Transition ALL buffered → done (used when stopping the session). */
  markAllBufferedDone(): void {
    let changed = false
    for (const item of this.items) {
      if (item.status === 'buffered') {
        item.status = 'done'
        changed = true
      }
    }
    if (changed) this.emit('changed', this.getQueue())
  }

  /** Drop ALL buffered items (used by skip/clear). */
  dropAllBuffered(): void {
    let changed = false
    for (const item of this.items) {
      if (item.status === 'buffered') {
        item.status = 'dropped'
        changed = true
      }
    }
    if (changed) this.emit('changed', this.getQueue())
  }

  /** Skip and drop the currently-playing item. */
  skipCurrent(): void {
    const playing = this.items.find(i => i.status === 'playing')
    if (playing) {
      playing.status = 'dropped'
      this.emit('changed', this.getQueue())
    }
  }

  /** Drop all non-playing pending/ready items. */
  clearPending(): void {
    let changed = false
    for (const item of this.items) {
      if (item.status === 'pending' || item.status === 'ready') {
        item.status = 'dropped'
        changed = true
      }
    }
    if (changed) this.emit('changed', this.getQueue())
  }

  /** Drop pending/ready items by predicate without affecting current audible items. */
  dropPendingBy(predicate: (item: PlaylistItem) => boolean): number {
    let dropped = 0
    for (const item of this.items) {
      if ((item.status === 'pending' || item.status === 'ready') && predicate(item)) {
        item.status = 'dropped'
        dropped++
      }
    }
    if (dropped > 0) {
      this.emit('changed', this.getQueue())
    }
    return dropped
  }

  dropPendingItem(id: string, reason?: string): boolean {
    const item = this.items.find(candidate =>
      candidate.id === id &&
      (candidate.status === 'pending' || candidate.status === 'ready')
    )
    if (!item) return false
    item.status = 'dropped'
    console.log(
      `[Queue] Dropped failed item: ${item.id}${reason ? `, reason=${reason}` : ''} (${item.text.slice(0, 30)})`
    )
    this.emit('changed', this.getQueue())
    return true
  }

  /** Called by TTS service when audio file is ready. */
  updateAudioPath(id: string, audioPath: string): void {
    const item = this.items.find(i => i.id === id)
    if (item && item.status === 'pending') {
      item.audioPath = audioPath
      item.status = 'ready'
      this.emit('changed', this.getQueue())
    }
  }

  updateTranslations(updates: Array<{ id: string; translatedText: string | null }>): void {
    let changed = false
    for (const update of updates) {
      const item = this.items.find(i => i.id === update.id)
      if (!item || item.status === 'dropped') continue
      const translatedText = update.translatedText ?? null
      if (item.translatedText === translatedText) continue
      item.translatedText = translatedText
      changed = true
    }
    if (changed) {
      this.emit('changed', this.getQueue())
    }
  }

  /** Returns active queue (excludes done/dropped) — used by internal logic. */
  getQueue(): PlaylistItem[] {
    return this.items.filter(i => i.status !== 'done' && i.status !== 'dropped')
  }

  /**
   * Returns queue for UI display — includes done items so the user
   * can see playback progress (which items already played, which is
   * currently playing, which are waiting). Excludes dropped. Keeps
   * last 80 items max for performance.
   */
  getDisplayQueue(): PlaylistItem[] {
    const visible = this.items.filter(i => i.status !== 'dropped')
    if (visible.length > 80) return visible.slice(-80)
    return visible
  }

  getCurrentlyPlaying(): PlaylistItem | null {
    return this.items.find(i => i.status === 'playing') ?? null
  }

  getPendingCount(): number {
    return this.items.filter(i => i.status === 'pending' || i.status === 'ready').length
  }

  getReadyCount(): number {
    return this.items.filter(i => i.status === 'ready' && i.audioPath !== null).length
  }

  private dropStale(): void {
    const now = Date.now()
    let dropped = false
    for (const item of this.items) {
      // Only drop 'pending' items (TTS stuck/failed).
      // 'ready' items have their audio and are just waiting to be played — don't drop them.
      if (
        item.status === 'pending' &&
        now - item.insertedAt > this.staleMs
      ) {
        item.status = 'dropped'
        dropped = true
        console.log(`[Queue] Dropped stale pending item: ${item.id} (${item.text.slice(0, 30)})`)
      }
    }
    if (dropped) this.emit('changed', this.getQueue())
  }
}

export const queueManager = new QueueManager()
