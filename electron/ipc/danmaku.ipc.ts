import { ipcMain, BrowserWindow } from 'electron'
import { danmakuService, DanmakuMessage } from '../services/danmaku.service'
import { danmakuReplyService } from '../services/danmaku-reply.service'
import { eventBatcher } from '../services/event-batcher'

function getMainWindow(): BrowserWindow | null {
  const wins = BrowserWindow.getAllWindows()
  for (const w of wins) {
    if (w.isDestroyed()) continue
    const url = w.webContents.getURL()
    if (!url.includes('player.html')) return w
  }
  return null
}

function sendToRenderer(channel: string, ...args: any[]): void {
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, ...args)
  }
}

export function registerDanmakuIpc(): void {
  // Connect to danmaku
  ipcMain.handle('danmaku:connect', async (_event, roomId: number) => {
    try {
      await danmakuService.connect(roomId)
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // Disconnect
  ipcMain.handle('danmaku:disconnect', () => {
    danmakuService.disconnect()
    return { success: true }
  })

  // Status
  ipcMain.handle('danmaku:status', () => {
    return {
      connected: danmakuService.isConnected(),
      roomId: danmakuService.getRoomId(),
      autoReply: danmakuReplyService.isEnabled()
    }
  })

  // Auto-reply toggle
  ipcMain.handle('danmaku:set-auto-reply', (_event, enabled: boolean) => {
    danmakuReplyService.setEnabled(enabled)
    return { success: true }
  })

  // Cooldown
  ipcMain.handle('danmaku:set-cooldown', (_event, ms: number) => {
    danmakuReplyService.setCooldown(ms)
    return { success: true }
  })

  // Forbidden words
  ipcMain.handle('danmaku:set-forbidden-words', (_event, words: string[]) => {
    danmakuReplyService.setForbiddenWords(words)
    eventBatcher.setForbiddenWords(words)
    return { success: true }
  })

  // Blacklist
  ipcMain.handle('danmaku:set-blacklist', (_event, userIds: string[]) => {
    danmakuReplyService.setBlacklist(userIds)
    eventBatcher.setBlacklist(userIds)
    return { success: true }
  })

  // Forward events to renderer + feed into eventBatcher for AI loop
  danmakuService.on('danmaku', (msg: DanmakuMessage) => {
    sendToRenderer('danmaku:message', msg)
    eventBatcher.addEvent({
      userId: String(msg.uid || ''),
      nickname: msg.username || '',
      content: msg.text || '',
      type: 'comment',
      timestamp: msg.timestamp || Date.now()
    })
  })

  danmakuService.on('connected', (roomId: number) => {
    sendToRenderer('danmaku:connected', roomId)
  })

  danmakuService.on('disconnected', () => {
    sendToRenderer('danmaku:disconnected')
  })

  danmakuService.on('popularity', (count: number) => {
    sendToRenderer('danmaku:popularity', count)
  })

  danmakuService.on('error', (error: string) => {
    sendToRenderer('danmaku:error', error)
  })

}
