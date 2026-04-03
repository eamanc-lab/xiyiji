import { dbAll, dbGet } from '../db/index'
import type { RoomTemperature } from './room-temperature'

export interface LinkInfo {
  id: string
  slotNo: number
  name: string
  content: string
}

export type RoomAiMode =
  | 'full_ai'
  | 'semi_ai'
  | 'no_ai'
  | 'ordered_generalize_ai'

function normalizeAiMode(value: unknown): RoomAiMode {
  return value === 'semi_ai' ||
    value === 'no_ai' ||
    value === 'ordered_generalize_ai'
    ? value
    : 'full_ai'
}

function normalizeOutputLanguage(value: unknown): string {
  return value === 'en' || value === 'es' ? value : 'zh-CN'
}

export interface ScriptSourceContext {
  key: string
  type: 'general' | 'link'
  name: string
  content: string
  linkId: string | null
}

export interface BatchContext {
  aiSystemPrompt: string       // Tab4: AI system prompt
  generalScript: string        // Tab1: full general script (no truncation)
  allLinks: LinkInfo[]         // Tab2: all product links with scripts
  activeLink: LinkInfo | null  // Tab2: currently active link
  shortcuts: string[]          // Tab3: shortcut script texts
  forbiddenWords: string[]     // Tab4: forbidden words
  recentDanmaku: string[]      // recent danmaku messages
  recentResponses: string[]    // recently played responses
  playingText: string          // currently playing text
  batchSize: number            // desired generation count
  outputLanguage: string       // output language code: 'zh-CN' | 'en' | 'es'
  // Temperature-aware fields
  temperature: RoomTemperature       // current room temperature
  temperatureHint: string            // temperature-specific generation instruction
  giftSummary: string                // gift accumulation text
  priorityDanmaku: string[]          // priority danmaku that need immediate response (★ marked)
  isDanmakuResponse: boolean         // true = use danmaku-focused prompt (direct viewer response)
}

export interface RoomSession {
  roomId: string
  activeLinkId: string | null
  generalScript: string
  allLinks: LinkInfo[]
  shortcuts: string[]
  forbiddenWords: string[]
  recentResponses: Array<{ text: string; at: number }>
}

/**
 * Manages in-memory state for each active room session.
 * Loads ALL script data at start time for full-context AI generation.
 */
class RoomSessionService {
  private sessions = new Map<string, RoomSession>()

  start(roomId: string): void {
    if (this.sessions.has(roomId)) return

    // Load general script
    const general = dbGet(
      `SELECT content FROM scripts WHERE room_id = ? AND type = 'general' LIMIT 1`,
      [roomId]
    )

    // Load all link scripts (join room_links with their scripts)
    const links = dbAll(
      `SELECT rl.id, rl.slot_no, rl.name, COALESCE(s.content, '') as content
       FROM room_links rl
       LEFT JOIN scripts s ON s.link_id = rl.id AND s.type = 'link'
       WHERE rl.room_id = ?
       ORDER BY rl.slot_no`,
      [roomId]
    )
    const allLinks: LinkInfo[] = links.map(r => ({
      id: r.id as string,
      slotNo: r.slot_no as number,
      name: r.name as string,
      content: r.content as string
    }))

    // Load shortcut scripts
    const shortcutRows = dbAll(
      `SELECT content FROM scripts WHERE room_id = ? AND type = 'shortcut'`,
      [roomId]
    )
    const shortcuts = shortcutRows
      .map(r => r.content as string)
      .filter(s => s.trim().length > 0)

    // Load forbidden words
    const forbiddenRows = dbAll(
      'SELECT word FROM forbidden_words WHERE room_id = ?',
      [roomId]
    )
    const forbiddenWords = forbiddenRows.map(r => r.word as string)

    this.sessions.set(roomId, {
      roomId,
      activeLinkId: null,
      generalScript: (general?.content as string) || '',
      allLinks,
      shortcuts,
      forbiddenWords,
      recentResponses: []
    })

    console.log(
      `[RoomSession] Started session for room: ${roomId}` +
      ` (links: ${allLinks.length}, shortcuts: ${shortcuts.length}, forbidden: ${forbiddenWords.length})`
    )
  }

  stop(roomId: string): void {
    this.sessions.delete(roomId)
    console.log(`[RoomSession] Stopped session for room: ${roomId}`)
  }

  getSession(roomId: string): RoomSession | undefined {
    return this.sessions.get(roomId)
  }

  switchLink(roomId: string, linkId: string | null): void {
    const session = this.sessions.get(roomId)
    if (!session) return
    session.activeLinkId = linkId
    console.log(`[RoomSession] Room ${roomId} switched link to: ${linkId}`)
  }

  getLinkScript(roomId: string): { name: string; content: string } {
    const session = this.sessions.get(roomId)
    if (!session || !session.activeLinkId) return { name: '', content: '' }

    const link = session.allLinks.find(l => l.id === session.activeLinkId)
    if (!link) return { name: '', content: '' }

    return { name: link.name, content: link.content }
  }

  recordResponse(roomId: string, text: string): void {
    const session = this.sessions.get(roomId)
    if (!session) return
    session.recentResponses.push({ text, at: Date.now() })
    if (session.recentResponses.length > 10) {
      session.recentResponses.shift()
    }
  }

  getContextSummary(roomId: string): string {
    const session = this.sessions.get(roomId)
    if (!session || session.recentResponses.length === 0) return ''
    return session.recentResponses
      .slice(-3)
      .map(r => r.text.slice(0, 40))
      .join(' / ')
  }

  getAiSettings(roomId: string): { aiSystemPrompt: string; aiMode: RoomAiMode; outputLanguage: string } {
    const row = dbGet('SELECT ai_system_prompt, ai_mode, output_language FROM room_settings WHERE room_id = ?', [roomId])
    return {
      aiSystemPrompt: (row?.ai_system_prompt as string) || '',
      aiMode: normalizeAiMode(row?.ai_mode),
      outputLanguage: normalizeOutputLanguage(row?.output_language)
    }
  }

  getForbiddenWords(roomId: string): string[] {
    const rows = dbAll('SELECT word FROM forbidden_words WHERE room_id = ?', [roomId])
    return rows.map(r => r.word as string)
  }

  getBlacklist(roomId: string): string[] {
    const rows = dbAll('SELECT platform_user_id FROM blacklist WHERE room_id = ?', [roomId])
    return rows.map(r => r.platform_user_id as string)
  }

  /** Get link IDs sorted by slot_no, for auto-rotation ordering. */
  getSortedLinkIds(roomId: string): string[] {
    const session = this.sessions.get(roomId)
    if (!session) return []
    return session.allLinks
      .slice()
      .sort((a, b) => a.slotNo - b.slotNo)
      .map(l => l.id)
  }

  /** Get link name by ID, for danmaku keyword matching. */
  getLinkNameMap(roomId: string): Map<string, string> {
    const session = this.sessions.get(roomId)
    if (!session) return new Map()
    return new Map(session.allLinks.map(l => [l.id, l.name]))
  }

  /**
   * Resolve the current script source for non-freeform playback.
   * Active link script takes priority when it exists and has content;
   * otherwise we fall back to the room's general script.
   */
  getCurrentScriptSource(roomId: string): ScriptSourceContext | null {
    const session = this.sessions.get(roomId)
    if (!session) return null

    const activeLink = session.activeLinkId
      ? session.allLinks.find(l => l.id === session.activeLinkId) || null
      : null

    if (activeLink && activeLink.content.trim()) {
      return {
        key: `link:${activeLink.id}`,
        type: 'link',
        name: activeLink.name || `链接${activeLink.slotNo}`,
        content: activeLink.content,
        linkId: activeLink.id
      }
    }

    if (session.generalScript.trim()) {
      return {
        key: 'general',
        type: 'general',
        name: '通用脚本',
        content: session.generalScript,
        linkId: null
      }
    }

    if (activeLink && activeLink.content.trim().length === 0) {
      return {
        key: `link:${activeLink.id}`,
        type: 'link',
        name: activeLink.name || `链接${activeLink.slotNo}`,
        content: '',
        linkId: activeLink.id
      }
    }

    return null
  }

  /**
   * Build full BatchContext for AI batch generation.
   * Aggregates all script data from the 4 sub-tabs.
   */
  buildBatchContext(roomId: string, danmaku: string[], playingText: string): BatchContext | null {
    const session = this.sessions.get(roomId)
    if (!session) return null

    const aiSettings = this.getAiSettings(roomId)
    const activeLink = session.activeLinkId
      ? session.allLinks.find(l => l.id === session.activeLinkId) || null
      : null

    return {
      aiSystemPrompt: aiSettings.aiSystemPrompt,
      generalScript: session.generalScript,
      allLinks: session.allLinks,
      activeLink,
      shortcuts: session.shortcuts,
      forbiddenWords: session.forbiddenWords,
      recentDanmaku: danmaku,
      recentResponses: session.recentResponses.slice(-5).map(r => r.text),
      playingText,
      batchSize: 12,
      outputLanguage: aiSettings.outputLanguage,
      // Defaults — caller (aiLoopService) will override with real values
      temperature: 'cold' as RoomTemperature,
      temperatureHint: '',
      giftSummary: '',
      priorityDanmaku: [],
      isDanmakuResponse: false
    }
  }
}

export const roomSessionService = new RoomSessionService()
