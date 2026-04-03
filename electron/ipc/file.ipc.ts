import { ipcMain, dialog, BrowserWindow } from 'electron'
import { existsSync, copyFileSync, statSync, readdirSync } from 'fs'
import { join, extname, basename } from 'path'

const VIDEO_EXTENSIONS = ['mp4', 'avi', 'mov', 'mkv', 'wmv', 'webm']

export function registerFileIpc(): void {
  ipcMain.handle('file:select-video', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return { path: null }
    const result = await dialog.showOpenDialog(win, {
      title: '选择视频文件',
      filters: [
        { name: '视频文件', extensions: ['mp4', 'avi', 'mov', 'mkv', 'wmv'] }
      ],
      properties: ['openFile']
    })
    return { path: result.canceled ? null : result.filePaths[0] }
  })

  ipcMain.handle('file:select-audio', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return { path: null }
    const result = await dialog.showOpenDialog(win, {
      title: '选择音频文件',
      filters: [
        { name: '音频文件', extensions: ['wav', 'mp3', 'flac', 'aac', 'ogg'] }
      ],
      properties: ['openFile']
    })
    return { path: result.canceled ? null : result.filePaths[0] }
  })

  ipcMain.handle('file:select-image', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return { path: null }
    const result = await dialog.showOpenDialog(win, {
      title: '选择图片文件',
      filters: [
        { name: '图片文件', extensions: ['jpg', 'jpeg', 'png', 'bmp', 'webp'] }
      ],
      properties: ['openFile']
    })
    return { path: result.canceled ? null : result.filePaths[0] }
  })

  ipcMain.handle('file:select-dir', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return { path: null }
    const result = await dialog.showOpenDialog(win, {
      title: '选择目录',
      properties: ['openDirectory']
    })
    return { path: result.canceled ? null : result.filePaths[0] }
  })

  ipcMain.handle('file:save-dialog', async (event, defaultName: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return { path: null }
    const result = await dialog.showSaveDialog(win, {
      title: '保存文件',
      defaultPath: defaultName,
      filters: [
        { name: '视频文件', extensions: ['mp4'] }
      ]
    })
    return { path: result.canceled ? null : result.filePath }
  })

  ipcMain.handle('file:exists', (_event, filePath: string) => {
    return existsSync(filePath)
  })

  ipcMain.handle('file:copy', (_event, src: string, dest: string) => {
    try {
      copyFileSync(src, dest)
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // Select multiple video files
  ipcMain.handle('file:select-videos', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return { paths: [] }
    const result = await dialog.showOpenDialog(win, {
      title: '选择视频文件',
      filters: [
        { name: '视频文件', extensions: VIDEO_EXTENSIONS }
      ],
      properties: ['openFile', 'multiSelections']
    })
    return { paths: result.canceled ? [] : result.filePaths }
  })

  // Scan directory for video files
  ipcMain.handle('file:scan-video-dir', async (_event, dirPath: string) => {
    try {
      const files = readdirSync(dirPath)
      const videoFiles = files
        .filter(f => VIDEO_EXTENSIONS.includes(extname(f).slice(1).toLowerCase()))
        .map(f => join(dirPath, f))
      return { paths: videoFiles }
    } catch (err: any) {
      return { paths: [], error: err.message }
    }
  })

  ipcMain.handle('file:get-video-info', async (_event, filePath: string) => {
    try {
      const stat = statSync(filePath)
      // Try to get actual video info with ffprobe
      let videoInfo: any = {}
      try {
        const { extractVideoInfo } = require('../utils/ffmpeg')
        videoInfo = await extractVideoInfo(filePath)
      } catch {
        // FFmpeg not available, return basic info
      }
      return {
        exists: true,
        size: stat.size,
        path: filePath,
        name: basename(filePath),
        ...videoInfo
      }
    } catch {
      return { exists: false }
    }
  })

  // Extract thumbnail
  ipcMain.handle('file:extract-thumbnail', async (_event, videoPath: string, outputPath: string) => {
    try {
      const { extractThumbnail } = require('../utils/ffmpeg')
      await extractThumbnail(videoPath, outputPath)
      return { success: true, path: outputPath }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })
}
