import { ipcMain, app } from 'electron'
import { exec } from 'child_process'
import { promisify } from 'util'
import { platform, totalmem, freemem, cpus } from 'os'
import { getLogFilePath, openLogsFolder } from '../utils/logger'

const execAsync = promisify(exec)

export function registerSystemIpc(): void {
  ipcMain.handle('system:info', async () => {
    const info: any = {
      platform: platform(),
      totalMemory: Math.round(totalmem() / 1024 / 1024 / 1024 * 10) / 10,
      freeMemory: Math.round(freemem() / 1024 / 1024 / 1024 * 10) / 10,
      cpuModel: cpus()[0]?.model || 'Unknown',
      cpuCores: cpus().length
    }

    // Try to get GPU info via nvidia-smi
    try {
      const { stdout } = await execAsync(
        'nvidia-smi --query-gpu=name,memory.total,memory.used,utilization.gpu --format=csv,noheader,nounits',
        { timeout: 5000 }
      )
      const parts = stdout.trim().split(',').map((s) => s.trim())
      if (parts.length >= 4) {
        info.gpu = {
          name: parts[0],
          memoryTotal: parseInt(parts[1]),
          memoryUsed: parseInt(parts[2]),
          utilization: parseInt(parts[3])
        }
      }
    } catch {
      info.gpu = null
    }

    return info
  })

  ipcMain.handle('system:disk-space', async (_event, drive: string) => {
    try {
      const { stdout } = await execAsync(
        `wmic logicaldisk where "DeviceID='${drive}:'" get FreeSpace,Size /format:csv`,
        { timeout: 5000 }
      )
      const lines = stdout.trim().split('\n').filter((l) => l.trim())
      if (lines.length >= 2) {
        const parts = lines[lines.length - 1].split(',')
        const freeSpace = parseInt(parts[1]) || 0
        const totalSize = parseInt(parts[2]) || 0
        return {
          free: Math.round(freeSpace / 1024 / 1024 / 1024 * 10) / 10,
          total: Math.round(totalSize / 1024 / 1024 / 1024 * 10) / 10
        }
      }
    } catch {
      // ignore
    }
    return { free: 0, total: 0 }
  })

  ipcMain.handle('app:info', () => ({
    version: app.getVersion()
  }))
  ipcMain.handle('app:path', () => app.getAppPath())
  ipcMain.handle('app:user-data-path', () => app.getPath('userData'))

  // Log file access
  ipcMain.handle('log:get-path', () => getLogFilePath())
  ipcMain.handle('log:open-folder', () => openLogsFolder())
}
