import { dbGet, dbRun, saveDatabase } from '../db/index'
import { getConfig } from '../config'
import { v4 as uuidv4 } from 'uuid'
import { BrowserWindow } from 'electron'

export type LicenseStatus = 'valid' | 'warn' | 'critical' | 'expired' | 'none'

export interface LicenseInfo {
  status: LicenseStatus
  tier: string
  expiresAt: string | null
  daysRemaining: number | null
  hoursRemaining: number | null
  hoursTotal: number | null
  nickname: string
}

export interface LoginResult {
  ok: boolean
  error?: string
  info?: LicenseInfo
}

function getServerUrl(): string {
  const url = getConfig('license_server_url')
  return url ? url.replace(/\/+$/, '') : ''
}

/**
 * HTTP helper — uses Node built-in fetch (Electron 33+ ships with it).
 */
async function apiFetch(path: string, options: { method?: string; body?: any; token?: string } = {}): Promise<any> {
  const baseUrl = getServerUrl()
  if (!baseUrl) throw new Error('未配置授权服务器地址，请在设置页填写')

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (options.token) headers['Authorization'] = `Bearer ${options.token}`

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15000) // 15s timeout

  let resp: Response
  try {
    resp = await fetch(`${baseUrl}${path}`, {
      method: options.method || 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal
    })
  } catch (err: any) {
    clearTimeout(timeout)
    if (err.name === 'AbortError') throw new Error('服务器请求超时(15s)')
    throw new Error(`网络连接失败: ${err.message}`)
  }
  clearTimeout(timeout)

  let data: any
  try {
    data = await resp.json()
  } catch {
    throw new Error(`服务器返回异常 (HTTP ${resp.status})`)
  }

  if (!resp.ok && !data.error) {
    throw new Error(`HTTP ${resp.status}`)
  }
  return data
}

class LicenseService {
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private heartbeatStartTime: number = 0

  getInfo(): LicenseInfo {
    const row = dbGet('SELECT * FROM accounts LIMIT 1')
    const token = (row?.jwt_token as string) || (row?.token_encrypted as string) || ''
    if (!row || !token) {
      return { status: 'none', tier: '', expiresAt: null, daysRemaining: null, hoursRemaining: null, hoursTotal: null, nickname: '' }
    }

    const expiresAt = (row.license_expires_at as string) || null
    const hoursRemaining = (row.hours_remaining as number) ?? null
    const hoursTotal = (row.hours_total as number) ?? null
    const nickname = (row.nickname as string) || ''
    const tier = (row.license_tier as string) || (row.tier as string) || 'standard'

    let daysRemaining: number | null = null
    let status: LicenseStatus = 'valid'

    if (expiresAt) {
      const now = Date.now()
      const expMs = new Date(expiresAt).getTime()
      daysRemaining = Math.ceil((expMs - now) / (1000 * 60 * 60 * 24))

      if (daysRemaining <= 0) {
        status = 'expired'
      } else if (daysRemaining <= 1) {
        status = 'critical'
      } else if (daysRemaining <= 7) {
        status = 'warn'
      }
    }

    // Check hours exhausted
    if (hoursTotal && hoursTotal > 0 && hoursRemaining !== null && hoursRemaining <= 0) {
      status = 'expired'
    }

    return { status, tier, expiresAt, daysRemaining, hoursRemaining, hoursTotal, nickname }
  }

  saveToken(username: string, token: string, tier: string, expiresAt: string | null): void {
    const existing = dbGet('SELECT id FROM accounts LIMIT 1')
    if (existing?.id) {
      dbRun(
        `UPDATE accounts
         SET username = ?, token_encrypted = ?, jwt_token = ?, license_tier = ?, license_expires_at = ?, status = 'active'
         WHERE id = ?`,
        [username, token, token, tier, expiresAt, existing.id]
      )
    } else {
      dbRun(
        `INSERT INTO accounts (id, username, token_encrypted, jwt_token, license_tier, license_expires_at, status)
         VALUES (?, ?, ?, ?, ?, ?, 'active')`,
        [uuidv4(), username, token, token, tier, expiresAt]
      )
    }
    saveDatabase()
  }

  /**
   * Check if remote auth is configured.
   */
  isRemoteConfigured(): boolean {
    return !!getServerUrl()
  }

  /**
   * Remote login via license server API.
   */
  async login(username: string, password: string): Promise<LoginResult> {
    // If no server configured, use legacy local mode
    if (!this.isRemoteConfigured()) {
      return this.localLogin(username, password)
    }

    try {
      const data = await apiFetch('/api/auth/login', {
        method: 'POST',
        body: { username, password }
      })

      if (!data.ok) {
        return { ok: false, error: data.error || '登录失败' }
      }

      // Save to local DB
      const account = data.account
      const existing = dbGet('SELECT id FROM accounts LIMIT 1')
      if (existing) {
        dbRun(
          `UPDATE accounts SET username = ?, nickname = ?, jwt_token = ?, license_expires_at = ?,
           hours_total = ?, hours_remaining = ?, status = ?, token_encrypted = ?
           WHERE id = ?`,
          [account.username, account.nickname, data.token, account.expiresAt || null,
           account.hoursTotal || 0, account.hoursRemaining || 0, account.status || 'active',
           data.token, existing.id]
        )
      } else {
        dbRun(
          `INSERT INTO accounts (id, username, nickname, jwt_token, license_expires_at,
           hours_total, hours_remaining, status, token_encrypted)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [uuidv4(), account.username, account.nickname, data.token, account.expiresAt || null,
           account.hoursTotal || 0, account.hoursRemaining || 0, account.status || 'active',
           data.token]
        )
      }
      saveDatabase()

      return { ok: true, info: this.getInfo() }
    } catch (err: any) {
      return { ok: false, error: err.message || '登录失败' }
    }
  }

  /**
   * Legacy local login (when no server URL configured).
   */
  private localLogin(username: string, password: string): LoginResult {
    // Accept any credentials in local mode — just save a token
    const tokenEncrypted = Buffer.from(`${username}:${password}`).toString('base64')
    const existing = dbGet('SELECT id FROM accounts LIMIT 1')
    if (existing) {
      dbRun(
        `UPDATE accounts SET username = ?, token_encrypted = ?, jwt_token = ?, status = 'active' WHERE id = ?`,
        [username, tokenEncrypted, tokenEncrypted, existing.id]
      )
    } else {
      dbRun(
        `INSERT INTO accounts (id, username, token_encrypted, jwt_token, status) VALUES (?, ?, ?, ?, 'active')`,
        [uuidv4(), username, tokenEncrypted, tokenEncrypted]
      )
    }
    saveDatabase()
    return { ok: true, info: this.getInfo() }
  }

  /**
   * Fetch latest status from server and update local cache.
   */
  async fetchStatus(): Promise<LicenseInfo> {
    if (!this.isRemoteConfigured()) return this.getInfo()
    const token = this.getJwtToken()
    if (!token) return this.getInfo()

    try {
      const data = await apiFetch('/api/auth/status', { token })
      const existing = dbGet('SELECT id FROM accounts LIMIT 1')
      if (existing) {
        dbRun(
          `UPDATE accounts SET license_expires_at = ?, hours_remaining = ?, hours_total = ?, status = ? WHERE id = ?`,
          [data.expiresAt || null, data.hoursRemaining || 0, data.hoursTotal || 0, data.status || 'active', existing.id]
        )
        saveDatabase()
      }
    } catch (err: any) {
      console.warn('[License] fetchStatus failed:', err.message)
    }

    return this.getInfo()
  }

  /**
   * Send heartbeat to server (deducts 1 hour).
   * Returns { ok, hoursRemaining, shouldStop }
   */
  async heartbeat(machineId?: string): Promise<{ ok: boolean; hoursRemaining?: number; shouldStop?: boolean; error?: string }> {
    const token = this.getJwtToken()
    if (!token) return { ok: false, error: 'Not logged in', shouldStop: true }

    try {
      const data = await apiFetch('/api/auth/heartbeat', {
        method: 'POST',
        token,
        body: { hours: 1.0, machineId: machineId || 'unknown' }
      })

      if (!data.ok) {
        return { ok: false, error: data.error, shouldStop: data.shouldStop ?? false }
      }

      // Update local cache
      const existing = dbGet('SELECT id FROM accounts LIMIT 1')
      if (existing) {
        dbRun(
          `UPDATE accounts SET hours_remaining = ?, license_expires_at = ? WHERE id = ?`,
          [data.hoursRemaining ?? 0, data.expiresAt || null, existing.id]
        )
        saveDatabase()
      }

      // Notify renderer
      this.notifyRenderer()

      return { ok: true, hoursRemaining: data.hoursRemaining, shouldStop: data.shouldStop ?? false }
    } catch (err: any) {
      console.error('[License] heartbeat failed:', err.message)
      // Network failure — don't stop, allow offline grace period
      return { ok: false, error: err.message, shouldStop: false }
    }
  }

  /**
   * Start heartbeat timer (every 1 hour).
   */
  startHeartbeat(): void {
    // Always record session start time (for elapsed timer display)
    this.heartbeatStartTime = Date.now()

    // Skip remote heartbeat when no server configured
    if (!this.isRemoteConfigured()) return

    // Sync stop: just clear timer without reporting partial (avoid async race)
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    console.log('[License] Starting heartbeat timer (1h interval)')

    this.heartbeatTimer = setInterval(async () => {
      const result = await this.heartbeat()
      console.log(`[License] Heartbeat result: remaining=${result.hoursRemaining}h, shouldStop=${result.shouldStop}`)

      if (result.shouldStop) {
        // Notify renderer to stop live
        const wins = BrowserWindow.getAllWindows()
        for (const win of wins) {
          win.webContents.send('license:should-stop', { reason: result.error || '直播时长已用完' })
        }
      }
    }, 60 * 60 * 1000) // 1 hour
  }

  /**
   * Stop heartbeat timer and report partial hour.
   */
  async stopHeartbeat(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null

      // Report partial hour
      if (this.heartbeatStartTime > 0) {
        const elapsed = Date.now() - this.heartbeatStartTime
        const partialHours = (elapsed % (60 * 60 * 1000)) / (60 * 60 * 1000)
        if (partialHours > 0.01) { // only report if > ~36 seconds
          const token = this.getJwtToken()
          if (token) {
            try {
              await apiFetch('/api/auth/heartbeat', {
                method: 'POST',
                token,
                body: { hours: Math.round(partialHours * 100) / 100, machineId: 'unknown' }
              })
              console.log(`[License] Reported partial hour: ${partialHours.toFixed(2)}h`)
            } catch (err: any) {
              console.warn('[License] Failed to report partial hour:', err.message)
            }
          }
        }
      }
    }
    // Always clear session start time (even in local mode without timer)
    this.heartbeatStartTime = 0
  }

  getJwtToken(): string | null {
    const row = dbGet('SELECT jwt_token FROM accounts LIMIT 1')
    return (row?.jwt_token as string) ?? null
  }

  clearToken(): void {
    dbRun('DELETE FROM accounts')
    saveDatabase()
  }

  /**
   * Logout: stop heartbeat, clear DB account, notify renderer.
   */
  async logout(): Promise<void> {
    await this.stopHeartbeat()
    this.clearToken()
    this.notifyRenderer()
  }

  /**
   * Get the current session start time (for live duration display).
   * Returns 0 if not streaming.
   */
  getSessionStartTime(): number {
    return this.heartbeatStartTime
  }

  isValid(): boolean {
    const info = this.getInfo()
    return info.status === 'valid' || info.status === 'warn' || info.status === 'critical'
  }

  /**
   * Check if license allows starting a live stream.
   */
  canStartLive(): { allowed: boolean; reason?: string } {
    // If no remote server, always allow
    if (!this.isRemoteConfigured()) {
      return { allowed: true }
    }

    const info = this.getInfo()
    if (info.status === 'expired') {
      return { allowed: false, reason: '授权已过期，请联系管理员续费' }
    }
    if (info.status === 'none') {
      return { allowed: false, reason: '未登录，请先登录' }
    }
    if (info.hoursTotal && info.hoursTotal > 0 && info.hoursRemaining !== null && info.hoursRemaining <= 0) {
      return { allowed: false, reason: '直播时长已用完，请联系管理员充值' }
    }
    return { allowed: true }
  }

  private notifyRenderer(): void {
    try {
      const wins = BrowserWindow.getAllWindows()
      const info = this.getInfo()
      for (const win of wins) {
        win.webContents.send('license:status-update', info)
      }
    } catch { /* ignore */ }
  }
}

export const licenseService = new LicenseService()
