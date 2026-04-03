import { ipcMain } from 'electron'
import { existsSync, unlinkSync } from 'fs'
import { v4 as uuidv4 } from 'uuid'
import { dbAll, dbGet, dbRun, saveDatabase } from '../db/index'
import {
  copyFileToManagedStorage,
  ensurePortableDataDirs,
  isManagedPortablePath
} from '../utils/portable-data'

export function registerAssetIpc(): void {
  // List all avatar videos
  ipcMain.handle('asset:list', () => {
    return dbAll('SELECT * FROM avatar_videos ORDER BY created_at DESC')
  })

  // Get single asset
  ipcMain.handle('asset:get', (_e, id: string) => {
    return dbGet('SELECT * FROM avatar_videos WHERE id = ?', [id])
  })

  // Import a video file
  ipcMain.handle('asset:import', (_e, data: { filePath: string; name: string }) => {
    if (!existsSync(data.filePath)) {
      return { ok: false, error: 'File not found: ' + data.filePath }
    }

    ensurePortableDataDirs()

    let managedPath = ''
    try {
      managedPath = copyFileToManagedStorage(data.filePath, 'avatar')
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to copy imported video' }
    }

    const existing = dbGet('SELECT id FROM avatar_videos WHERE file_path = ?', [managedPath])
    if (existing) {
      return { ok: false, error: 'File already imported' }
    }
    const id = uuidv4()
    dbRun(
      `INSERT INTO avatar_videos (id, name, file_path) VALUES (?, ?, ?)`,
      [id, data.name, managedPath]
    )
    saveDatabase()
    return { ok: true, record: dbGet('SELECT * FROM avatar_videos WHERE id = ?', [id]) }
  })

  // Rename asset
  ipcMain.handle('asset:rename', (_e, id: string, name: string) => {
    dbRun('UPDATE avatar_videos SET name = ? WHERE id = ?', [name, id])
    saveDatabase()
    return { ok: true }
  })

  // Delete asset (check no profile references it)
  ipcMain.handle('asset:delete', (_e, id: string) => {
    const asset = dbGet('SELECT * FROM avatar_videos WHERE id = ?', [id])
    if (!asset) return { ok: false, error: 'Asset not found' }

    const inUse = dbGet('SELECT id FROM dh_profiles WHERE video_id = ? LIMIT 1', [id])
    if (inUse) return { ok: false, error: 'Asset is used by a profile' }

    // Try to delete the physical file
    try {
      if (isManagedPortablePath(asset.file_path as string) && existsSync(asset.file_path as string)) {
        unlinkSync(asset.file_path as string)
      }
    } catch (err: any) {
      console.warn('[Asset] Could not delete file:', err.message)
    }
    if (asset.thumbnail_path) {
      try {
        if (
          isManagedPortablePath(asset.thumbnail_path as string) &&
          existsSync(asset.thumbnail_path as string)
        ) {
          unlinkSync(asset.thumbnail_path as string)
        }
      } catch { /* ignore */ }
    }

    dbRun('DELETE FROM avatar_videos WHERE id = ?', [id])
    saveDatabase()
    return { ok: true }
  })

  // Set thumbnail path
  ipcMain.handle('asset:set-thumbnail', (_e, id: string, thumbnailPath: string) => {
    if (!thumbnailPath || !existsSync(thumbnailPath)) {
      dbRun('UPDATE avatar_videos SET thumbnail_path = NULL WHERE id = ?', [id])
      saveDatabase()
      return { ok: true }
    }

    ensurePortableDataDirs()

    const managedPath = copyFileToManagedStorage(thumbnailPath, 'thumbnail')
    dbRun('UPDATE avatar_videos SET thumbnail_path = ? WHERE id = ?', [managedPath, id])
    saveDatabase()
    return { ok: true }
  })

  // Set face detected flag
  ipcMain.handle('asset:set-face-detected', (_e, id: string, value: 0 | 1) => {
    dbRun('UPDATE avatar_videos SET face_detected = ? WHERE id = ?', [value, id])
    saveDatabase()
    return { ok: true }
  })
}
