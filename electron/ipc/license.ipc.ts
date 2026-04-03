import { ipcMain } from 'electron'
import { licenseService } from '../services/license.service'

export function registerLicenseIpc(): void {
  ipcMain.handle('license:get-info', () => {
    return licenseService.getInfo()
  })

  /**
   * 登录验证：通过远程授权服务器验证账号密码
   */
  ipcMain.handle('license:login', async (_e, account: string, password: string) => {
    try {
      if (!account || !password) {
        return { ok: false, error: '请输入账号和密码' }
      }
      return await licenseService.login(account, password)
    } catch (err: any) {
      return { ok: false, error: err.message || '登录失败' }
    }
  })

  /**
   * 刷新远程状态
   */
  ipcMain.handle('license:refresh', async () => {
    try {
      const info = await licenseService.fetchStatus()
      return { ok: true, info }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })

  /**
   * 检查是否可以开播
   */
  ipcMain.handle('license:can-start-live', () => {
    return licenseService.canStartLive()
  })

  ipcMain.handle('license:activate', (_e, _token: string) => {
    // Legacy — no longer used with remote auth
    return { ok: false, error: '请通过账号密码登录' }
  })

  ipcMain.handle('license:deactivate', () => {
    licenseService.clearToken()
    return { ok: true }
  })

  ipcMain.handle('license:logout', async () => {
    try {
      await licenseService.logout()
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle('license:session-start-time', () => {
    return licenseService.getSessionStartTime()
  })
}
