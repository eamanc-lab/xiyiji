// Allow full-length reference clips for video-stream direct_playback mode.
// Must be set before any module imports yundingyunbo-avatar.ts (which reads
// these env vars once at module-load time to compute clip duration constants).
if (!process.env.YDB_AVATAR_REFERENCE_MAX_DURATION_SEC) {
  process.env.YDB_AVATAR_REFERENCE_MAX_DURATION_SEC = '36000'
}
if (!process.env.YDB_AVATAR_REFERENCE_TARGET_FRAMES) {
  process.env.YDB_AVATAR_REFERENCE_TARGET_FRAMES = '0'
}

import { app, BrowserWindow, shell } from 'electron'
import { dirname, join } from 'path'
import { mkdirSync, writeFileSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerAllIpc } from '../../electron/ipc/index'
import { initDatabase, closeDatabase } from '../../electron/db/index'
import { initLipSyncBackends } from '../../electron/services/lipsync-init'
import { getActiveBackend } from '../../electron/services/lipsync-backend'
import { logStartupRuntimeSelfCheck } from '../../electron/services/runtime-selfcheck'
import { initLogger, closeLogger } from '../../electron/utils/logger'
import { getRuntimeStateRoot, hasDetectedWorkspaceRoot } from '../../electron/utils/app-paths'

// Note: transparent windows rely on display:none for video elements (not CSS visibility/opacity)
// because Chromium composites <video> as hardware overlays that bypass z-index.

let mainWindow: BrowserWindow | null = null
let startupHealthReported = false

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

function getArgValue(name: string): string {
  const prefix = `--${name}=`
  const arg = process.argv.find((item) => item.startsWith(prefix))
  return arg ? arg.slice(prefix.length) : ''
}

function reportStartupHealth(stage: string): void {
  if (startupHealthReported) return
  const healthFile = getArgValue('xiyiji-health-file')
  if (!healthFile) return

  try {
    mkdirSync(dirname(healthFile), { recursive: true })
    writeFileSync(
      healthFile,
      JSON.stringify(
        {
          ok: true,
          version: app.getVersion(),
          stage,
          pid: process.pid,
          timestamp: new Date().toISOString()
        },
        null,
        2
      ),
      'utf8'
    )
    startupHealthReported = true
  } catch (err: any) {
    console.warn(`[Startup] Failed to report health: ${err?.message || err}`)
  }
}

function configureDevCachePaths(): void {
  if (!is.dev) return
  try {
    const runtimeBase = join(getRuntimeStateRoot(), 'electron-dev')
    const sessionDir = join(runtimeBase, 'session')
    const cacheDir = join(runtimeBase, 'cache')
    mkdirSync(sessionDir, { recursive: true })
    mkdirSync(cacheDir, { recursive: true })
    app.setPath('sessionData', sessionDir)
    app.commandLine.appendSwitch('disk-cache-dir', cacheDir)
    app.commandLine.appendSwitch('disable-gpu-shader-disk-cache')
    console.log(`[Startup] Dev sessionData=${sessionDir}`)
    console.log(`[Startup] Dev diskCache=${cacheDir}`)
  } catch (err: any) {
    console.warn(`[Startup] configureDevCachePaths failed: ${err?.message || err}`)
  }
}

function configureLocalUserDataPath(): void {
  if (app.isPackaged || !hasDetectedWorkspaceRoot()) return
  try {
    const userDataDir = join(getRuntimeStateRoot(), 'userData')
    mkdirSync(userDataDir, { recursive: true })
    app.setPath('userData', userDataDir)
    console.log(`[Startup] Local userData=${userDataDir}`)
  } catch (err: any) {
    console.warn(`[Startup] configureLocalUserDataPath failed: ${err?.message || err}`)
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // 生产环境：拦截 DevTools 快捷键
  if (!is.dev) {
    mainWindow.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'F12') {
        event.preventDefault()
      }
      if (input.control && input.shift && ['I', 'J', 'C'].includes(input.key)) {
        event.preventDefault()
      }
    })
  }

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
    reportStartupHealth('ready-to-show')
    if (is.dev) {
      mainWindow?.webContents.openDevTools({ mode: 'detach' })
    }
  })

  mainWindow.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) {
      console.log(`[Renderer ${level === 2 ? 'WARN' : 'ERROR'}]:`, message)
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

configureLocalUserDataPath()
configureDevCachePaths()

// 生产环境：检测调试标志，阻止附加调试器
if (!is.dev) {
  const hasDebugFlag = process.argv.some(
    (arg) => arg.startsWith('--inspect') || arg.startsWith('--remote-debugging-port')
  )
  if (hasDebugFlag) {
    app.quit()
  }
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.xiyiji.app')
  initLogger()

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
    // 生产环境：禁用所有窗口的右键上下文菜单（防止"检查元素"）
    if (!is.dev) {
      window.webContents.on('context-menu', (e) => {
        e.preventDefault()
      })
    }
  })

  await initDatabase()
  initLipSyncBackends()
  registerAllIpc()
  void logStartupRuntimeSelfCheck().catch((err: any) => {
    console.warn(`[SelfCheck] Startup runtime check failed: ${err?.message || err}`)
  })
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  try {
    const backend = getActiveBackend()
    if (backend.shutdown) backend.shutdown()
  } catch {
    // ignore if no backend registered
  }
  closeDatabase()
  closeLogger()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
