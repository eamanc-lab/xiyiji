import { dbGet, dbRun } from './db/index'
import { BUNDLED_API_DEFAULTS } from './default-settings'
import { getDefaultDataDir, getDefaultLipSyncBackend, getDefaultOutputDir, normalizeLegacyPath } from './utils/app-paths'

// 静态默认配置（data_dir/output_dir 通过 getDefault() 延迟解析）
const STATIC_DEFAULTS: Record<string, string> = {
  ...BUNDLED_API_DEFAULTS,
  lipsync_backend: getDefaultLipSyncBackend(),
  dianjt_base: '',
  yundingyunbo_base: '',
}

function getDefault(key: string): string {
  if (key === 'data_dir') return getDefaultDataDir()
  if (key === 'output_dir') return getDefaultOutputDir()
  return STATIC_DEFAULTS[key] ?? ''
}

/**
 * Get a config value from SQLite settings table, falling back to defaults.
 */
export function getConfig(key: string): string {
  try {
    const row = dbGet('SELECT value FROM settings WHERE key = ?', [key])
    if (row?.value) return normalizeLegacyPath(key, String(row.value))
  } catch {
    // DB might not be ready yet
  }
  return getDefault(key)
}

/**
 * Set a config value in SQLite settings table.
 */
export function setConfig(key: string, value: string): void {
  dbRun(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now','localtime'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, value]
  )
}

/** All config keys that should have defaults in DB */
const ALL_DEFAULT_KEYS = [
  'dashscope_api_key', 'ucloud_tts_api_key', 'ucloud_tts_model',
  'ucloud_tts_base_url', 'dashscope_base_url', 'lipsync_backend', 'dianjt_base',
  'yundingyunbo_base', 'data_dir', 'output_dir', 'eulerstream_api_key', 'license_server_url',
  'update_manifest_url', 'full_package_url', 'full_package_code'
]

/**
 * Ensure all default config keys exist in settings table.
 * Called after DB initialization.
 */
export function ensureDefaultConfigs(): void {
  for (const key of ALL_DEFAULT_KEYS) {
    try {
      const existing = dbGet('SELECT value FROM settings WHERE key = ?', [key])
      if (!existing) {
        dbRun('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', [key, getDefault(key)])
      }
    } catch {
      // Ignore if DB not ready
    }
  }
}

// Convenience accessors
export function getDashscopeApiKey(): string {
  return getConfig('dashscope_api_key')
}

export function getUcloudTtsApiKey(): string {
  return getConfig('ucloud_tts_api_key')
}

export function getUcloudTtsModel(): string {
  return getConfig('ucloud_tts_model')
}

export function getUcloudTtsBaseUrl(): string {
  return getConfig('ucloud_tts_base_url')
}

export function getDashscopeBaseUrl(): string {
  return getConfig('dashscope_base_url')
}

export function getDataDir(): string {
  return getConfig('data_dir')
}

export function getOutputDir(): string {
  return getConfig('output_dir')
}

export function getLipSyncBackend(): string {
  return getConfig('lipsync_backend')
}

export function getEulerstreamApiKey(): string {
  return getConfig('eulerstream_api_key')
}

export function getLicenseServerUrl(): string {
  return getConfig('license_server_url')
}
