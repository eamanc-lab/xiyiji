import { ipcMain } from 'electron'
import { llmService, ChatMessage } from '../services/llm.service'
import { ttsService } from '../services/tts.service'
import { asrService } from '../services/asr.service'
import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { v4 as uuidv4 } from 'uuid'

function getTempDir(): string {
  const tmpDir = join(app.getPath('userData'), 'temp', 'chat')
  if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true })
  return tmpDir
}

export function registerChatIpc(): void {
  // Send message to LLM (non-streaming)
  ipcMain.handle('chat:send', async (_event, message: string, history: ChatMessage[]) => {
    try {
      const messages: ChatMessage[] = [...history, { role: 'user', content: message }]
      const result = await llmService.chat(messages)
      return { success: true, content: result.content, model: result.model }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // Send message to LLM (streaming)
  ipcMain.handle('chat:send-stream', async (_event, message: string, history: ChatMessage[]) => {
    try {
      const messages: ChatMessage[] = [...history, { role: 'user', content: message }]
      const result = await llmService.chatStream(messages)
      return { success: true, content: result.content, model: result.model }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // TTS for chat response
  ipcMain.handle('chat:tts', async (_event, text: string, voice: string, speed: number) => {
    try {
      const result = await ttsService.synthesize(voice, text, speed)
      return { success: true, audioPath: result.audioPath }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // ASR for chat voice input
  ipcMain.handle('chat:asr', async (_event, audioData: ArrayBuffer) => {
    try {
      // Write audio data to temp file
      const audioPath = join(getTempDir(), `asr_${uuidv4()}.wav`)
      writeFileSync(audioPath, Buffer.from(audioData))

      const result = await asrService.transcribe(audioPath)
      return { success: true, text: result.fullText, segments: result.segments }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })
}
