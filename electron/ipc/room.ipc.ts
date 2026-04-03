import { ipcMain } from 'electron'
import { v4 as uuidv4 } from 'uuid'
import { dbAll, dbGet, dbRun, saveDatabase } from '../db/index'

export function registerRoomIpc(): void {
  // List all rooms with profile name
  ipcMain.handle('room:list', () => {
    return dbAll(`
      SELECT r.*, p.name AS profile_name
      FROM rooms r
      LEFT JOIN dh_profiles p ON p.id = r.profile_id
      ORDER BY r.created_at DESC
    `)
  })

  // Get single room
  ipcMain.handle('room:get', (_e, id: string) => {
    return dbGet(`
      SELECT r.*, p.name AS profile_name
      FROM rooms r
      LEFT JOIN dh_profiles p ON p.id = r.profile_id
      WHERE r.id = ?
    `, [id])
  })

  // Create room + auto-create room_settings
  ipcMain.handle('room:create', (_e, data: { name: string; platform: string; profileId?: string }) => {
    const id = uuidv4()
    dbRun(
      `INSERT INTO rooms (id, name, platform, profile_id) VALUES (?, ?, ?, ?)`,
      [id, data.name, data.platform || 'douyin', data.profileId || null]
    )
    dbRun(`INSERT OR IGNORE INTO room_settings (room_id, ai_system_prompt) VALUES (?, '')`, [id])
    saveDatabase()
    return dbGet('SELECT * FROM rooms WHERE id = ?', [id])
  })

  // Update room
  ipcMain.handle('room:update', (_e, id: string, data: { name?: string; platform?: string; profileId?: string }) => {
    const fields: string[] = []
    const vals: unknown[] = []
    if (data.name !== undefined) { fields.push('name = ?'); vals.push(data.name) }
    if (data.platform !== undefined) { fields.push('platform = ?'); vals.push(data.platform) }
    if (data.profileId !== undefined) { fields.push('profile_id = ?'); vals.push(data.profileId || null) }
    if (fields.length === 0) return { ok: false, error: 'No fields to update' }
    vals.push(id)
    dbRun(`UPDATE rooms SET ${fields.join(', ')} WHERE id = ?`, vals)
    saveDatabase()
    return dbGet('SELECT * FROM rooms WHERE id = ?', [id])
  })

  // Delete room (only if not running)
  ipcMain.handle('room:delete', (_e, id: string) => {
    const room = dbGet('SELECT status FROM rooms WHERE id = ?', [id])
    if (!room) return { ok: false, error: 'Room not found' }
    if (room.status === 'running') return { ok: false, error: 'Cannot delete a running room' }
    dbRun('DELETE FROM rooms WHERE id = ?', [id])
    saveDatabase()
    return { ok: true }
  })

  // Set room status
  ipcMain.handle('room:set-status', (_e, id: string, status: string) => {
    dbRun('UPDATE rooms SET status = ? WHERE id = ?', [status, id])
    saveDatabase()
    return { ok: true }
  })

  // Copy room (all scripts, links, settings, forbidden words)
  ipcMain.handle('room:copy', (_e, id: string, newName: string) => {
    const src = dbGet('SELECT * FROM rooms WHERE id = ?', [id])
    if (!src) return { ok: false, error: 'Source room not found' }

    const newId = uuidv4()
    dbRun(
      `INSERT INTO rooms (id, name, platform, profile_id) VALUES (?, ?, ?, ?)`,
      [newId, newName, src.platform, src.profile_id]
    )
    dbRun(`INSERT OR IGNORE INTO room_settings (room_id, ai_system_prompt) VALUES (?, ?)`, [
      newId,
      (dbGet('SELECT ai_system_prompt FROM room_settings WHERE room_id = ?', [id])?.ai_system_prompt) || ''
    ])

    // Copy forbidden words
    const forbidden = dbAll('SELECT word FROM forbidden_words WHERE room_id = ?', [id])
    for (const fw of forbidden) {
      dbRun('INSERT OR IGNORE INTO forbidden_words (id, room_id, word) VALUES (?, ?, ?)', [uuidv4(), newId, fw.word])
    }

    // Copy room_links with id map for script link_id reference
    const links = dbAll('SELECT * FROM room_links WHERE room_id = ? ORDER BY slot_no', [id])
    const linkIdMap: Record<string, string> = {}
    for (const link of links) {
      const newLinkId = uuidv4()
      linkIdMap[link.id as string] = newLinkId
      dbRun('INSERT INTO room_links (id, room_id, slot_no, name) VALUES (?, ?, ?, ?)', [
        newLinkId, newId, link.slot_no, link.name
      ])
    }

    // Copy scripts
    const scripts = dbAll('SELECT * FROM scripts WHERE room_id = ?', [id])
    for (const s of scripts) {
      const newLinkId = s.link_id ? (linkIdMap[s.link_id as string] || null) : null
      dbRun(
        `INSERT INTO scripts (id, room_id, name, type, content, hotkey, link_id, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [uuidv4(), newId, s.name, s.type, s.content, s.hotkey, newLinkId, s.enabled]
      )
    }

    saveDatabase()
    return { ok: true, id: newId }
  })
}
