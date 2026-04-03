import { ipcMain, BrowserWindow } from 'electron'
import { getActiveBackend } from '../services/lipsync-backend'
import { ttsService } from '../services/tts.service'

export function registerLiveIpc(): void {
  // Start live F2F session
  ipcMain.handle('live:start', async (_event, data: {
    videoPath: string
    audioPath: string
  }) => {
    try {
      const result = await getActiveBackend().submit(data.videoPath, data.audioPath)
      return { success: true, taskId: result.task_id }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // Stop live session
  ipcMain.handle('live:stop', async () => {
    return { success: true }
  })

  // Get live status
  ipcMain.handle('live:status', async () => {
    const available = await getActiveBackend().isAvailable()
    return { f2fAvailable: available }
  })

  // Send audio data for F2F processing
  ipcMain.handle('live:send-audio', async (_event, audioData: ArrayBuffer) => {
    try {
      // Write audio to temp file for F2F
      const { writeFileSync } = require('fs')
      const { join } = require('path')
      const { app } = require('electron')
      const { v4: uuidv4 } = require('uuid')

      const tmpDir = join(app.getPath('userData'), 'temp', 'live')
      const { mkdirSync, existsSync } = require('fs')
      if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true })

      const audioPath = join(tmpDir, `live_${uuidv4()}.wav`)
      writeFileSync(audioPath, Buffer.from(audioData))

      return { success: true, audioPath }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // TTS synthesize (used by live TTS mode and voice preview)
  ipcMain.handle('tts:synthesize', async (_event, text: string, voice: string, speed: number) => {
    try {
      const result = await ttsService.synthesize(voice, text, speed)
      // Return audio data as ArrayBuffer so renderer can play via Blob URL
      // (file:// URLs are blocked by webSecurity in the main window)
      // Note: Buffer.buffer may have different byteOffset, so slice to get exact data
      const { readFileSync } = require('fs')
      const audioBuffer = readFileSync(result.audioPath)
      const exactData = audioBuffer.buffer.slice(
        audioBuffer.byteOffset,
        audioBuffer.byteOffset + audioBuffer.byteLength
      )
      return { success: true, audioPath: result.audioPath, audioData: exactData }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // List TTS voices
  ipcMain.handle('tts:voices', async () => {
    try {
      const voices = await ttsService.getAllVoices()
      return { success: true, voices }
    } catch (err: any) {
      return { success: false, error: err.message, voices: [] }
    }
  })

  // Upload a voice recording or imported audio file for cloning
  ipcMain.handle('tts:upload-voice', async (_event, name: string, audioData: ArrayBuffer, filename?: string) => {
    try {
      const { writeFileSync, mkdirSync, existsSync } = require('fs')
      const { join, extname } = require('path')
      const { app } = require('electron')
      const { v4: uuidv4 } = require('uuid')

      const tmpDir = join(app.getPath('userData'), 'temp', 'voice')
      if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true })

      // Preserve the original file extension so the TTS API receives the correct MIME type
      const ext = filename ? (extname(filename) || '.wav') : '.wav'
      const rawPath = join(tmpDir, `voice_raw_${uuidv4()}${ext}`)
      writeFileSync(rawPath, Buffer.from(audioData))

      // UCloud API only supports MP3/WAV (16kHz+, 5-30s).
      // Browser recordings (MediaRecorder) produce WebM/OGG which are NOT supported.
      // Always convert to WAV 16kHz mono to guarantee compatibility.
      let audioPath = rawPath
      const needsConvert = !['.wav', '.mp3'].includes(ext.toLowerCase())
      if (needsConvert) {
        try {
          const { detectFfmpeg } = require('../utils/ffmpeg')
          const { ffmpeg } = await detectFfmpeg()
          const wavPath = join(tmpDir, `voice_${uuidv4()}.wav`)
          const { execFile } = require('child_process')
          const { promisify } = require('util')
          const execFileAsync = promisify(execFile)
          await execFileAsync(ffmpeg, [
            '-i', rawPath,
            '-ar', '16000',   // 16kHz (API minimum)
            '-ac', '1',       // mono
            '-f', 'wav',
            '-y', wavPath
          ], { timeout: 30000 })
          audioPath = wavPath
          console.log(`[TTS] Converted ${ext} → WAV for voice upload`)
        } catch (convertErr: any) {
          console.warn('[TTS] FFmpeg convert failed, uploading original:', convertErr.message)
          // Fall back to uploading original file as-is
        }
      }

      const voice = await ttsService.uploadVoice(name, audioPath)
      return { ok: true, voice }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })

  // Delete a cloned voice
  ipcMain.handle('tts:delete-voice', async (_event, voiceId: string) => {
    try {
      await ttsService.deleteVoice(voiceId)
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })
}
