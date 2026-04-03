import { ipcMain, BrowserWindow } from 'electron'
import { platformManager } from '../services/platform/platform.manager'
import { eventBatcher } from '../services/event-batcher'

function getMainWindow(): BrowserWindow | null {
  const wins = BrowserWindow.getAllWindows()
  for (const w of wins) {
    if (w.isDestroyed()) continue
    const url = w.webContents.getURL()
    // 排除播放器窗口和视频号管理后台窗口，只找主窗口
    if (
      !url.includes('player.html') &&
      !url.includes('channels.weixin.qq.com')
    ) {
      return w
    }
  }
  return null
}

function sendToRenderer(channel: string, ...args: any[]): void {
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, ...args)
  }
}

export function registerPlatformIpc(): void {
  /** List all supported platforms */
  ipcMain.handle('platform:list', async () => {
    return platformManager.listPlatforms()
  })

  /** Get current connection status */
  ipcMain.handle('platform:status', async () => {
    return platformManager.getStatus()
  })

  /** Connect to a platform */
  ipcMain.handle('platform:connect', async (_e, platform: string, credential: any) => {
    try {
      await platformManager.connect(platform as any, credential, (event) => {
        // Route platform events to the event batcher
        eventBatcher.addEvent({
          type: event.type === 'danmaku' ? 'comment' : (event.type as any),
          userId: event.userId,
          nickname: event.userName,
          content: event.text || event.giftName || '',
          timestamp: event.timestamp
        })

        // Forward to renderer for display in danmaku panel
        sendToRenderer('platform:event', event)
      })
      return { ok: true }
    } catch (err: any) {
      console.error('[Platform IPC] connect failed:', err.message)
      return { ok: false, error: err.message }
    }
  })

  /** Disconnect from current platform */
  ipcMain.handle('platform:disconnect', async () => {
    platformManager.disconnect()
    return { ok: true }
  })
}
