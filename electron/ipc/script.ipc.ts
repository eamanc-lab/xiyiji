import { ipcMain } from 'electron'
import { v4 as uuidv4 } from 'uuid'
import { dbAll, dbGet, dbRun, saveDatabase } from '../db/index'

function normalizeAiMode(value: unknown): string {
  return value === 'semi_ai' ||
    value === 'no_ai' ||
    value === 'ordered_generalize_ai'
    ? value
    : 'full_ai'
}

function normalizeOutputLanguage(value: unknown): string {
  return value === 'en' || value === 'es' ? value : 'zh-CN'
}

export function registerScriptIpc(): void {
  // ── General script (one per room) ────────────────────────────────────────

  ipcMain.handle('script:get-general', (_e, roomId: string) => {
    return dbGet(
      `SELECT content FROM scripts WHERE room_id = ? AND type = 'general' LIMIT 1`,
      [roomId]
    )
  })

  ipcMain.handle('script:save-general', (_e, roomId: string, content: string) => {
    const existing = dbGet(
      `SELECT id FROM scripts WHERE room_id = ? AND type = 'general' LIMIT 1`,
      [roomId]
    )
    if (existing) {
      dbRun(
        `UPDATE scripts SET content = ?, updated_at = datetime('now','localtime') WHERE id = ?`,
        [content, existing.id]
      )
    } else {
      dbRun(
        `INSERT INTO scripts (id, room_id, name, type, content) VALUES (?, ?, '通用脚本', 'general', ?)`,
        [uuidv4(), roomId, content]
      )
    }
    saveDatabase()
    return { ok: true }
  })

  // ── Link scripts (up to 10 slots) ─────────────────────────────────────────

  ipcMain.handle('script:list-links', (_e, roomId: string) => {
    return dbAll(`
      SELECT rl.id, rl.room_id, rl.slot_no, rl.name,
             s.id AS script_id, s.content
      FROM room_links rl
      LEFT JOIN scripts s ON s.link_id = rl.id AND s.type = 'link'
      WHERE rl.room_id = ?
      ORDER BY rl.slot_no
    `, [roomId])
  })

  ipcMain.handle('script:save-link', (_e, roomId: string, slotNo: number, name: string, content: string) => {
    // Upsert room_links
    let link = dbGet('SELECT id FROM room_links WHERE room_id = ? AND slot_no = ?', [roomId, slotNo])
    let linkId: string
    if (link) {
      linkId = link.id as string
      dbRun('UPDATE room_links SET name = ? WHERE id = ?', [name, linkId])
    } else {
      linkId = uuidv4()
      dbRun('INSERT INTO room_links (id, room_id, slot_no, name) VALUES (?, ?, ?, ?)', [linkId, roomId, slotNo, name])
    }

    // Upsert script for this link
    const existingScript = dbGet(`SELECT id FROM scripts WHERE link_id = ? AND type = 'link'`, [linkId])
    if (existingScript) {
      dbRun(
        `UPDATE scripts SET content = ?, name = ?, updated_at = datetime('now','localtime') WHERE id = ?`,
        [content, name, existingScript.id]
      )
    } else {
      dbRun(
        `INSERT INTO scripts (id, room_id, name, type, content, link_id) VALUES (?, ?, ?, 'link', ?, ?)`,
        [uuidv4(), roomId, name, content, linkId]
      )
    }
    saveDatabase()
    return { ok: true, linkId }
  })

  ipcMain.handle('script:delete-link', (_e, roomId: string, slotNo: number) => {
    dbRun('DELETE FROM room_links WHERE room_id = ? AND slot_no = ?', [roomId, slotNo])
    saveDatabase()
    return { ok: true }
  })

  // ── Shortcut scripts ──────────────────────────────────────────────────────

  ipcMain.handle('script:list-shortcuts', (_e, roomId: string) => {
    return dbAll(
      `SELECT * FROM scripts WHERE room_id = ? AND type = 'shortcut' ORDER BY hotkey`,
      [roomId]
    )
  })

  ipcMain.handle('script:save-shortcut', (_e, roomId: string, data: {
    id?: string
    name: string
    content: string
    hotkey?: string
    enabled?: number
  }) => {
    if (data.id) {
      dbRun(
        `UPDATE scripts SET name = ?, content = ?, hotkey = ?, enabled = ?, updated_at = datetime('now','localtime') WHERE id = ?`,
        [data.name, data.content, data.hotkey || null, data.enabled ?? 1, data.id]
      )
    } else {
      const id = uuidv4()
      dbRun(
        `INSERT INTO scripts (id, room_id, name, type, content, hotkey, enabled) VALUES (?, ?, ?, 'shortcut', ?, ?, ?)`,
        [id, roomId, data.name, data.content, data.hotkey || null, data.enabled ?? 1]
      )
    }
    saveDatabase()
    return { ok: true }
  })

  ipcMain.handle('script:delete-shortcut', (_e, id: string) => {
    dbRun('DELETE FROM scripts WHERE id = ? AND type = ?', [id, 'shortcut'])
    saveDatabase()
    return { ok: true }
  })

  // ── Room settings (AI prompt) ─────────────────────────────────────────────

  ipcMain.handle('script:get-settings', (_e, roomId: string) => {
    return dbGet('SELECT * FROM room_settings WHERE room_id = ?', [roomId])
  })

  ipcMain.handle('script:save-settings', (_e, roomId: string, data: { aiSystemPrompt?: string; aiMode?: string; outputLanguage?: string }) => {
    const existing = dbGet('SELECT room_id FROM room_settings WHERE room_id = ?', [roomId])
    if (existing) {
      const fields: string[] = []
      const vals: any[] = []
      if (data.aiSystemPrompt !== undefined) { fields.push('ai_system_prompt = ?'); vals.push(data.aiSystemPrompt) }
      if (data.aiMode !== undefined) { fields.push('ai_mode = ?'); vals.push(normalizeAiMode(data.aiMode)) }
      if (data.outputLanguage !== undefined) { fields.push('output_language = ?'); vals.push(normalizeOutputLanguage(data.outputLanguage)) }
      if (fields.length > 0) {
        vals.push(roomId)
        dbRun(`UPDATE room_settings SET ${fields.join(', ')} WHERE room_id = ?`, vals)
      }
    } else {
      dbRun(
        `INSERT INTO room_settings (room_id, ai_system_prompt, ai_mode, output_language) VALUES (?, ?, ?, ?)`,
        [
          roomId,
          data.aiSystemPrompt ?? '',
          normalizeAiMode(data.aiMode),
          normalizeOutputLanguage(data.outputLanguage)
        ]
      )
    }
    saveDatabase()
    return { ok: true }
  })

  // ── Forbidden words ───────────────────────────────────────────────────────

  ipcMain.handle('script:list-forbidden', (_e, roomId: string) => {
    return dbAll('SELECT * FROM forbidden_words WHERE room_id = ? ORDER BY word', [roomId])
  })

  ipcMain.handle('script:add-forbidden', (_e, roomId: string, word: string) => {
    const trimmed = word.trim()
    if (!trimmed) return { ok: false, error: 'Empty word' }
    dbRun('INSERT OR IGNORE INTO forbidden_words (id, room_id, word) VALUES (?, ?, ?)', [uuidv4(), roomId, trimmed])
    saveDatabase()
    return { ok: true }
  })

  ipcMain.handle('script:delete-forbidden', (_e, id: string) => {
    dbRun('DELETE FROM forbidden_words WHERE id = ?', [id])
    saveDatabase()
    return { ok: true }
  })

  // ── Blacklist ─────────────────────────────────────────────────────────────

  ipcMain.handle('script:list-blacklist', (_e, roomId: string) => {
    return dbAll('SELECT * FROM blacklist WHERE room_id = ? ORDER BY created_at DESC', [roomId])
  })

  ipcMain.handle('script:add-blacklist', (_e, roomId: string, data: { platformUserId: string; note?: string }) => {
    dbRun(
      'INSERT INTO blacklist (id, room_id, platform_user_id, note) VALUES (?, ?, ?, ?)',
      [uuidv4(), roomId, data.platformUserId, data.note || '']
    )
    saveDatabase()
    return { ok: true }
  })

  ipcMain.handle('script:delete-blacklist', (_e, id: string) => {
    dbRun('DELETE FROM blacklist WHERE id = ?', [id])
    saveDatabase()
    return { ok: true }
  })
}
