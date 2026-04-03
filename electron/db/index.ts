import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js'
import { app } from 'electron'
import { join } from 'path'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { getBundledSettingsDefaults } from '../default-settings'
import { normalizeLegacyPath } from '../utils/app-paths'
import {
  copyFileToManagedStorage,
  ensurePortableDataDirs,
  getPortableDatabaseDir,
  getPortableDatabasePath,
  isManagedPortablePath,
  repairPortableMediaPath
} from '../utils/portable-data'

let db: SqlJsDatabase
let dbPath: string
let saveTimer: ReturnType<typeof setTimeout> | null = null

function uniq(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

function normalizeForCompare(targetPath: string): string {
  return String(targetPath || '').replace(/\//g, '\\').toLowerCase()
}

function getLegacyDatabaseCandidates(targetPath: string): string[] {
  const currentUserDataPath = app.getPath('userData')
  const appDataPath = app.getPath('appData')
  const appNames = uniq([app.getName?.(), (app as any)?.name, 'xiyiji'])

  return uniq([
    join(currentUserDataPath, 'data', 'xiyiji.db'),
    ...appNames.map((name) => join(appDataPath, name, 'data', 'xiyiji.db'))
  ]).filter((candidate) => normalizeForCompare(candidate) !== normalizeForCompare(targetPath))
}

function localizeMediaPath(sourcePath: string, kind: 'avatar' | 'thumbnail'): string {
  const repairedPath = repairPortableMediaPath(sourcePath)
  const candidate = repairedPath || sourcePath

  if (candidate && existsSync(candidate) && !isManagedPortablePath(candidate)) {
    try {
      return copyFileToManagedStorage(candidate, kind)
    } catch (err: any) {
      console.warn(
        `[DB] Failed to localize ${kind} asset "${candidate}": ${err?.message || err}`
      )
    }
  }

  return repairedPath
}

export function getDatabase(): SqlJsDatabase {
  if (!db) {
    throw new Error('Database not initialized')
  }
  return db
}

// Helper: run a query and return all rows as objects
export function dbAll(sql: string, params: any[] = []): any[] {
  const stmt = db.prepare(sql)
  if (params.length > 0) stmt.bind(params)
  const results: any[] = []
  while (stmt.step()) {
    results.push(stmt.getAsObject())
  }
  stmt.free()
  return results
}

// Helper: run a query and return first row
export function dbGet(sql: string, params: any[] = []): any | undefined {
  const rows = dbAll(sql, params)
  return rows[0]
}

// Helper: execute a statement (INSERT/UPDATE/DELETE)
export function dbRun(sql: string, params: any[] = []): void {
  db.run(sql, params)
  scheduleSave()
}

// Schedule a debounced save to disk
function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveDatabase()
  }, 500)
}

export function saveDatabase(): void {
  if (!db) return
  try {
    const data = db.export()
    const buffer = Buffer.from(data)
    writeFileSync(dbPath, buffer)
  } catch (err) {
    console.error('Failed to save database:', err)
  }
}

export async function initDatabase(): Promise<void> {
  dbPath = getPortableDatabasePath()
  const dbDir = getPortableDatabaseDir()

  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true })
  }

  ensurePortableDataDirs()

  if (!existsSync(dbPath)) {
    const sourceDb = getLegacyDatabaseCandidates(dbPath).find((candidate) => existsSync(candidate))
    if (sourceDb) {
      copyFileSync(sourceDb, dbPath)
      console.log(`[DB] Migrated database to local workspace: ${sourceDb} -> ${dbPath}`)
    }
  }

  const SQL = await initSqlJs()

  if (existsSync(dbPath)) {
    const fileBuffer = readFileSync(dbPath)
    db = new SQL.Database(fileBuffer)
  } else {
    db = new SQL.Database()
  }

  db.run('PRAGMA foreign_keys=ON;')
  createTables()
  runMigrations()
  insertDefaultSettings()
  repairPortableState()
  saveDatabase()
}

function createTables(): void {
  // ── New PRD tables ────────────────────────────────────────────────────────

  db.run(`CREATE TABLE IF NOT EXISTS accounts (
    id                  TEXT PRIMARY KEY,
    email               TEXT,
    token_encrypted     TEXT,
    license_tier        TEXT,
    license_expires_at  TEXT
  )`)

  db.run(`CREATE TABLE IF NOT EXISTS avatar_videos (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    file_path       TEXT NOT NULL UNIQUE,
    fps             REAL    DEFAULT 25,
    duration_sec    REAL    DEFAULT 0,
    face_detected   INTEGER DEFAULT 0,
    thumbnail_path  TEXT,
    created_at      TEXT    DEFAULT (datetime('now','localtime'))
  )`)

  db.run(`CREATE TABLE IF NOT EXISTS dh_profiles (
    id                    TEXT PRIMARY KEY,
    name                  TEXT NOT NULL,
    is_default            INTEGER DEFAULT 0,
    video_id              TEXT REFERENCES avatar_videos(id),
    vad_threshold         REAL    DEFAULT 0.02,
    vad_post_silence_ms   INTEGER DEFAULT 500,
    tts_voice             TEXT    DEFAULT 'jack_cheng',
    tts_speed             REAL    DEFAULT 1.0,
    tts_volume            REAL    DEFAULT 0.8,
    created_at            TEXT    DEFAULT (datetime('now','localtime')),
    updated_at            TEXT    DEFAULT (datetime('now','localtime'))
  )`)

  db.run(`CREATE TABLE IF NOT EXISTS api_keys (
    id            TEXT PRIMARY KEY,
    provider      TEXT NOT NULL UNIQUE,
    key_encrypted TEXT NOT NULL,
    extra         TEXT
  )`)

  db.run(`CREATE TABLE IF NOT EXISTS platform_credentials (
    id                   TEXT PRIMARY KEY,
    platform             TEXT NOT NULL UNIQUE,
    credential_encrypted TEXT,
    is_connected         INTEGER DEFAULT 0
  )`)

  db.run(`CREATE TABLE IF NOT EXISTS rooms (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    platform   TEXT NOT NULL DEFAULT 'douyin',
    status     TEXT NOT NULL DEFAULT 'idle',
    profile_id TEXT REFERENCES dh_profiles(id),
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )`)

  db.run(`CREATE TABLE IF NOT EXISTS room_links (
    id      TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    slot_no INTEGER NOT NULL,
    name    TEXT NOT NULL DEFAULT '',
    UNIQUE(room_id, slot_no)
  )`)

  db.run(`CREATE TABLE IF NOT EXISTS scripts (
    id         TEXT PRIMARY KEY,
    room_id    TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    name       TEXT NOT NULL DEFAULT '',
    type       TEXT NOT NULL,
    content    TEXT    DEFAULT '',
    hotkey     TEXT,
    link_id    TEXT REFERENCES room_links(id) ON DELETE SET NULL,
    enabled    INTEGER DEFAULT 1,
    created_at TEXT    DEFAULT (datetime('now','localtime')),
    updated_at TEXT    DEFAULT (datetime('now','localtime'))
  )`)

  db.run(`CREATE TABLE IF NOT EXISTS room_settings (
    room_id          TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
    ai_system_prompt TEXT DEFAULT ''
  )`)

  db.run(`CREATE TABLE IF NOT EXISTS forbidden_words (
    id      TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    word    TEXT NOT NULL,
    UNIQUE(room_id, word)
  )`)

  db.run(`CREATE TABLE IF NOT EXISTS blacklist (
    id               TEXT PRIMARY KEY,
    room_id          TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    platform_user_id TEXT NOT NULL,
    note             TEXT DEFAULT '',
    created_at       TEXT DEFAULT (datetime('now','localtime'))
  )`)

  // ── Existing tables ───────────────────────────────────────────────────────

  db.run(`
    CREATE TABLE IF NOT EXISTS avatars (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'processing',
      source_video TEXT NOT NULL,
      thumbnail TEXT,
      video_duration REAL,
      video_width INTEGER,
      video_height INTEGER,
      face_data_path TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )
  `)
  db.run(`
    CREATE TABLE IF NOT EXISTS voices (
      id TEXT PRIMARY KEY,
      avatar_id TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'training',
      speaker_id TEXT,
      source_audio TEXT,
      transcript TEXT,
      audio_duration REAL,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (avatar_id) REFERENCES avatars(id) ON DELETE CASCADE
    )
  `)
  db.run(`
    CREATE TABLE IF NOT EXISTS synth_tasks (
      id TEXT PRIMARY KEY,
      avatar_id TEXT NOT NULL,
      voice_id TEXT,
      drive_mode TEXT NOT NULL,
      input_text TEXT,
      input_audio TEXT,
      tts_audio TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      progress INTEGER DEFAULT 0,
      f2f_task_id TEXT,
      result_video TEXT,
      result_duration REAL,
      result_size INTEGER,
      error_message TEXT,
      queue_order INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      completed_at TEXT,
      FOREIGN KEY (avatar_id) REFERENCES avatars(id),
      FOREIGN KEY (voice_id) REFERENCES voices(id)
    )
  `)
  db.run(`
    CREATE TABLE IF NOT EXISTS greenscreen_presets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      hue_min INTEGER DEFAULT 35,
      hue_max INTEGER DEFAULT 85,
      sat_min INTEGER DEFAULT 80,
      sat_max INTEGER DEFAULT 255,
      val_min INTEGER DEFAULT 80,
      val_max INTEGER DEFAULT 255,
      smoothing INTEGER DEFAULT 1,
      similarity INTEGER DEFAULT 50,
      bg_type TEXT DEFAULT 'color',
      bg_value TEXT,
      is_default INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )
  `)
  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )
  `)
}

function insertDefaultSettings(): void {
  const defaults = getBundledSettingsDefaults()
  const backendMigrationMarker = 'lipsync_backend_auto_migrated_20260320'

  for (const [key, value] of Object.entries(defaults)) {
    db.run('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', [key, value])
  }

  const bundledEulerKey = defaults.eulerstream_api_key
  if (bundledEulerKey) {
    db.run(
      `UPDATE settings
       SET value = ?
       WHERE key = 'eulerstream_api_key'
         AND (value IS NULL OR TRIM(value) = '')`,
      [bundledEulerKey]
    )
  }

  const bundledBackend = defaults.lipsync_backend
  if (bundledBackend) {
    db.run(
      `UPDATE settings
       SET value = ?
       WHERE key = 'lipsync_backend'
         AND (value IS NULL OR TRIM(value) = '')`,
      [bundledBackend]
    )
  }

  // Packaged customer builds now default to yundingyunbo. For machines that
  // already ran an older build, migrate the old default heygem setting once
  // so the new package works out-of-the-box without manual settings changes.
  if (bundledBackend === 'yundingyunbo') {
    const migrated = dbGet('SELECT value FROM settings WHERE key = ?', [backendMigrationMarker])
    if (!migrated?.value) {
      db.run(
        `UPDATE settings
         SET value = ?
         WHERE key = 'lipsync_backend'
           AND (value IS NULL OR TRIM(value) = '' OR value = 'heygem')`,
        [bundledBackend]
      )
      db.run(
        `INSERT OR REPLACE INTO settings (key, value, updated_at)
         VALUES (?, ?, datetime('now','localtime'))`,
        [backendMigrationMarker, '1']
      )
    }
  }
}

function runMigrations(): void {
  const safeMigrate = (sql: string) => { try { db.run(sql) } catch { /* column exists */ } }

  safeMigrate('ALTER TABLE dh_profiles ADD COLUMN camera_device_id TEXT DEFAULT NULL')
  safeMigrate('ALTER TABLE dh_profiles ADD COLUMN camera_device_label TEXT DEFAULT NULL')
  safeMigrate("ALTER TABLE dh_profiles ADD COLUMN media_type TEXT DEFAULT 'video'")
  safeMigrate('ALTER TABLE dh_profiles ADD COLUMN chroma_enabled INTEGER DEFAULT 0')
  safeMigrate('ALTER TABLE dh_profiles ADD COLUMN chroma_similarity INTEGER DEFAULT 80')
  safeMigrate('ALTER TABLE dh_profiles ADD COLUMN chroma_smoothing INTEGER DEFAULT 1')
  safeMigrate("ALTER TABLE room_settings ADD COLUMN ai_mode TEXT DEFAULT 'full_ai'")
  safeMigrate('ALTER TABLE scripts ADD COLUMN hotkey TEXT')
  safeMigrate('ALTER TABLE scripts ADD COLUMN enabled INTEGER DEFAULT 1')
  safeMigrate('ALTER TABLE room_settings ADD COLUMN auto_rotation_enabled INTEGER DEFAULT 0')
  safeMigrate('ALTER TABLE room_settings ADD COLUMN auto_rotation_batches INTEGER DEFAULT 1')
  safeMigrate("ALTER TABLE room_settings ADD COLUMN output_language TEXT DEFAULT 'zh-CN'")

  // License remote auth fields
  safeMigrate('ALTER TABLE accounts ADD COLUMN username TEXT')
  safeMigrate('ALTER TABLE accounts ADD COLUMN nickname TEXT')
  safeMigrate('ALTER TABLE accounts ADD COLUMN jwt_token TEXT')
  safeMigrate('ALTER TABLE accounts ADD COLUMN hours_total REAL DEFAULT 0')
  safeMigrate('ALTER TABLE accounts ADD COLUMN hours_remaining REAL DEFAULT 0')
  safeMigrate("ALTER TABLE accounts ADD COLUMN status TEXT DEFAULT 'active'")
}

function repairPortableState(): void {
  let repairedSettings = 0
  let repairedAssets = 0

  for (const key of ['data_dir', 'output_dir', 'dianjt_base', 'yundingyunbo_base']) {
    const row = dbGet('SELECT value FROM settings WHERE key = ?', [key])
    const currentValue = String(row?.value || '')
    const repairedValue = normalizeLegacyPath(key, currentValue)
    if (currentValue && repairedValue && repairedValue !== currentValue) {
      db.run(
        `UPDATE settings
         SET value = ?, updated_at = datetime('now','localtime')
         WHERE key = ?`,
        [repairedValue, key]
      )
      repairedSettings += 1
    }
  }

  for (const row of dbAll('SELECT id, file_path, thumbnail_path FROM avatar_videos')) {
    const filePath = String(row.file_path || '')
    const repairedFilePath = localizeMediaPath(filePath, 'avatar')
    if (filePath && repairedFilePath && repairedFilePath !== filePath) {
      db.run('UPDATE avatar_videos SET file_path = ? WHERE id = ?', [repairedFilePath, row.id])
      repairedAssets += 1
    }

    const thumbnailPath = String(row.thumbnail_path || '')
    const repairedThumbnailPath = localizeMediaPath(thumbnailPath, 'thumbnail')
    if (thumbnailPath && repairedThumbnailPath && repairedThumbnailPath !== thumbnailPath) {
      db.run('UPDATE avatar_videos SET thumbnail_path = ? WHERE id = ?', [
        repairedThumbnailPath,
        row.id
      ])
      repairedAssets += 1
    }
  }

  if (repairedSettings > 0 || repairedAssets > 0) {
    console.log(
      `[DB] Repaired local runtime state: settings=${repairedSettings}, assets=${repairedAssets}`
    )
  }
}

export function closeDatabase(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveDatabase()
  if (db) {
    db.close()
  }
}
