import { ipcMain } from 'electron'
import {
  applyUpdateAndRestart,
  checkForUpdates,
  clearUpdaterResultMessage,
  downloadUpdate,
  getAppUpdaterState,
  openFullPackageLink
} from '../services/app-updater.service'

export function registerUpdaterIpc(): void {
  ipcMain.handle('updater:get-state', () => getAppUpdaterState())
  ipcMain.handle('updater:check', (_event, manifestUrl?: string) => checkForUpdates(manifestUrl))
  ipcMain.handle('updater:download', (_event, manifestUrl?: string) => downloadUpdate(manifestUrl))
  ipcMain.handle('updater:apply', () => applyUpdateAndRestart())
  ipcMain.handle('updater:open-full-package', () => openFullPackageLink())
  ipcMain.handle('updater:clear-result', () => clearUpdaterResultMessage())
}
