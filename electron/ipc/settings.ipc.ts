import { ipcMain } from 'electron'
import { dbAll, dbGet, dbRun } from '../db/index'
import { getConfig } from '../config'
import { normalizeLegacyPath } from '../utils/app-paths'

export function registerSettingsIpc(): void {
  ipcMain.handle('settings:get', (_event, key: string) => {
    return getConfig(key)
  })

  ipcMain.handle('settings:set', (_event, key: string, value: string) => {
    dbRun(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now','localtime'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, value]
    )
    return { success: true }
  })

  ipcMain.handle('settings:getAll', () => {
    const rows = dbAll('SELECT key, value FROM settings')
    const result: Record<string, string> = {}
    for (const row of rows) {
      result[row.key] = normalizeLegacyPath(String(row.key), String(row.value))
    }
    return result
  })
}
