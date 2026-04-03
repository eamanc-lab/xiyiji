import axios from 'axios'
import { getUcloudTtsApiKey, getUcloudTtsModel, getUcloudTtsBaseUrl } from '../config'
import { writeFileSync, readFileSync } from 'fs'
import { join, extname } from 'path'
import { app } from 'electron'
import { v4 as uuidv4 } from 'uuid'
import FormData from 'form-data'
import { Agent as HttpsAgent } from 'https'
import { concatAudioFiles } from '../utils/ffmpeg'

export interface VoiceInfo {
  id: string
  name: string
  expires_in_days?: number
  created_at?: string
}

// Preset voices from UCloud IndexTTS-2
export const PRESET_VOICES: VoiceInfo[] = [
  { id: 'sales_voice', name: '销售之声 - 男声·推荐直播' },
  { id: 'jack_cheng', name: '程澄 - 男声·成熟稳重' },
  { id: 'crystla_liu', name: '晶晶 - 女声·温柔甜美' },
  { id: 'stephen_chow', name: '星爷风 - 男声·幽默' },
  { id: 'xiaoyueyue', name: '小岳岳风 - 男声·亲和' },
  { id: 'entertain', name: '娱乐 - 综艺风格' },
  { id: 'novel', name: '小说 - 有声书风格' },
  { id: 'movie', name: '电影 - 影视解说风格' },
  { id: 'mkas', name: 'MKAS - 特色音色' }
]

const TTS_REQUEST_TIMEOUT_MS = 60_000
const TTS_SYNTH_RETRY_COUNT = 2
const TTS_SYNTH_RETRY_BASE_DELAY_MS = 900
const TTS_FALLBACK_PRESET_VOICE = 'jack_cheng'
const VOICE_LIST_CACHE_MS = 60_000

type SpeechResult = {
  buffer: Buffer
  usedVoice: string
}

export class TtsService {
  private readonly speechAgent = new HttpsAgent({ keepAlive: false })
  private voiceListCache: { expiresAt: number; voices: VoiceInfo[] } | null = null

  private getHeaders() {
    return {
      Authorization: `Bearer ${getUcloudTtsApiKey()}`,
      'Content-Type': 'application/json'
    }
  }

  private getBaseUrl() {
    return getUcloudTtsBaseUrl()
  }

  private getTempDir(): string {
    const tmpDir = join(app.getPath('userData'), 'temp', 'tts')
    const { mkdirSync, existsSync } = require('fs')
    if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true })
    return tmpDir
  }

  private async delay(ms: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, ms))
  }

  private truncateText(text: string, maxLen: number = 120): string {
    const normalized = String(text || '')
      .replace(/\s+/g, ' ')
      .trim()
    if (normalized.length <= maxLen) return normalized
    return `${normalized.slice(0, maxLen)}...`
  }

  private describeError(err: unknown): string {
    if (axios.isAxiosError(err)) {
      const parts = [err.message]
      if (err.code) parts.push(`code=${err.code}`)
      if (err.response?.status) parts.push(`status=${err.response.status}`)
      return parts.join(', ')
    }
    if (err instanceof Error) return err.message
    return String(err)
  }

  private serializeProviderData(data: unknown): string {
    try {
      if (Buffer.isBuffer(data)) {
        return this.truncateText(data.toString('utf8'), 240)
      }

      if (data instanceof ArrayBuffer) {
        return this.truncateText(Buffer.from(data).toString('utf8'), 240)
      }

      if (ArrayBuffer.isView(data)) {
        return this.truncateText(
          Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8'),
          240
        )
      }

      if (typeof data === 'string') {
        return this.truncateText(data, 240)
      }

      if (data && typeof data === 'object') {
        return this.truncateText(JSON.stringify(data), 240)
      }

      return data == null ? '' : this.truncateText(String(data), 240)
    } catch {
      return '[unserializable-response]'
    }
  }

  private isClonedVoice(voice: string): boolean {
    return /^uspeech:/i.test(String(voice || '').trim())
  }

  private invalidateVoiceListCache(): void {
    this.voiceListCache = null
  }

  private logSpeechRequestFailure(
    err: unknown,
    text: string,
    voice: string,
    speed: number,
    attempt: number,
    retriesRemaining: number
  ): void {
    const base = [
      `[TTS] Synthesize request failed`,
      `voice=${voice}`,
      `model=${getUcloudTtsModel()}`,
      `baseUrl=${this.getBaseUrl()}`,
      `speed=${speed}`,
      `attempt=${attempt}`,
      `retriesRemaining=${Math.max(0, retriesRemaining)}`,
      `text="${this.truncateText(text, 80)}"`
    ]

    if (axios.isAxiosError(err)) {
      if (err.code) base.push(`code=${err.code}`)
      if (err.response?.status) base.push(`status=${err.response.status}`)
      const payload = this.serializeProviderData(err.response?.data)
      if (payload) base.push(`response=${payload}`)
    } else if (err instanceof Error) {
      base.push(`error=${err.message}`)
    } else {
      base.push(`error=${String(err)}`)
    }

    console.warn(base.join(', '))
  }

  private isRetryableSynthesizeError(err: unknown): boolean {
    if (axios.isAxiosError(err)) {
      const status = err.response?.status ?? 0
      if (status === 429 || status >= 500) return true

      const code = (err.code || '').toUpperCase()
      if (['ECONNABORTED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE'].includes(code)) return true
    }

    const message = this.describeError(err).toLowerCase()
    return (
      message.includes('bad_decrypt') ||
      message.includes('stream has been aborted') ||
      message.includes('socket hang up') ||
      message.includes('read econnreset') ||
      message.includes('timeout')
    )
  }

  private async requestSpeech(text: string, voice: string, speed: number): Promise<Buffer> {
    let lastError: unknown = null

    for (let attempt = 1; attempt <= TTS_SYNTH_RETRY_COUNT + 1; attempt++) {
      try {
        const resp = await axios.post(
          `${this.getBaseUrl()}/audio/speech`,
          {
            model: getUcloudTtsModel(),
            input: text,
            voice,
            speed,
            sample_rate: 22050
          },
          {
            headers: this.getHeaders(),
            httpsAgent: this.speechAgent,
            responseType: 'arraybuffer',
            timeout: TTS_REQUEST_TIMEOUT_MS
          }
        )

        return Buffer.from(resp.data)
      } catch (err) {
        lastError = err
        const retriesRemaining = TTS_SYNTH_RETRY_COUNT + 1 - attempt
        this.logSpeechRequestFailure(err, text, voice, speed, attempt, retriesRemaining)
        if (!this.isRetryableSynthesizeError(err) || retriesRemaining <= 0) break

        await this.delay(TTS_SYNTH_RETRY_BASE_DELAY_MS * attempt)
      }
    }

    if (lastError instanceof Error) throw lastError
    throw new Error(this.describeError(lastError))
  }

  private async listVoicesCached(forceRefresh: boolean = false): Promise<VoiceInfo[]> {
    const now = Date.now()
    if (!forceRefresh && this.voiceListCache && this.voiceListCache.expiresAt > now) {
      return this.voiceListCache.voices
    }

    const resp = await axios.get(`${this.getBaseUrl()}/audio/voice/list`, {
      headers: { Authorization: `Bearer ${getUcloudTtsApiKey()}` },
      httpsAgent: this.speechAgent,
      timeout: 15000
    })

    const voices: VoiceInfo[] = resp.data?.list || resp.data?.data || resp.data?.voices || []
    this.voiceListCache = {
      expiresAt: now + VOICE_LIST_CACHE_MS,
      voices
    }
    return voices
  }

  private async shouldFallbackToPresetVoice(requestedVoice: string, err: unknown): Promise<boolean> {
    if (!this.isClonedVoice(requestedVoice) || !axios.isAxiosError(err)) return false

    const status = err.response?.status ?? 0
    if (![400, 404, 410].includes(status)) return false

    const payload = this.serializeProviderData(err.response?.data).toLowerCase()
    const explicitVoiceHint =
      payload.includes('voice') ||
      payload.includes('speaker') ||
      payload.includes('音色') ||
      payload.includes('not found') ||
      payload.includes('not_exist') ||
      payload.includes('不存在') ||
      payload.includes('invalid voice')

    try {
      const voices = await this.listVoicesCached(true)
      const exists = voices.some((voice) => voice.id === requestedVoice)
      if (!exists) {
        console.warn(
          `[TTS] Requested cloned voice is missing from provider voice list, fallback=${TTS_FALLBACK_PRESET_VOICE}, requested=${requestedVoice}`
        )
        return true
      }

      if (explicitVoiceHint) {
        console.warn(
          `[TTS] Provider rejected cloned voice although it still appears in voice list, requested=${requestedVoice}`
        )
      }
      return false
    } catch (listErr) {
      console.warn(
        `[TTS] Failed to refresh voice list while validating cloned voice ${requestedVoice}: ${this.describeError(listErr)}`
      )
      return explicitVoiceHint
    }
  }

  private async requestSpeechWithFallback(
    text: string,
    voice: string,
    speed: number
  ): Promise<SpeechResult> {
    try {
      return {
        buffer: await this.requestSpeech(text, voice, speed),
        usedVoice: voice
      }
    } catch (err) {
      if (!(await this.shouldFallbackToPresetVoice(voice, err))) {
        throw err
      }

      try {
        const buffer = await this.requestSpeech(text, TTS_FALLBACK_PRESET_VOICE, speed)
        console.warn(
          `[TTS] Fallback preset voice activated, requested=${voice}, actual=${TTS_FALLBACK_PRESET_VOICE}`
        )
        return {
          buffer,
          usedVoice: TTS_FALLBACK_PRESET_VOICE
        }
      } catch (fallbackErr) {
        console.error(
          `[TTS] Fallback preset voice failed, requested=${voice}, fallback=${TTS_FALLBACK_PRESET_VOICE}, original=${this.describeError(err)}, fallbackError=${this.describeError(fallbackErr)}`
        )
        throw err
      }
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const apiKey = getUcloudTtsApiKey()
      if (!apiKey) return false
      await this.listVoicesCached(true)
      return true
    } catch {
      return false
    }
  }

  private splitText(text: string, maxLen: number = 600): string[] {
    if (text.length <= maxLen) return [text]

    const chunks: string[] = []
    let remaining = text

    while (remaining.length > 0) {
      if (remaining.length <= maxLen) {
        chunks.push(remaining)
        break
      }

      let splitIdx = -1
      const punctuation = ['。', '！', '？', '；', '\n', '.', '!', '?', ';']

      for (let i = maxLen - 1; i >= maxLen / 2; i--) {
        if (punctuation.includes(remaining[i])) {
          splitIdx = i + 1
          break
        }
      }

      if (splitIdx === -1) {
        for (let i = maxLen - 1; i >= maxLen / 2; i--) {
          if ([',', '，', '、'].includes(remaining[i])) {
            splitIdx = i + 1
            break
          }
        }
      }

      if (splitIdx === -1) {
        splitIdx = maxLen
      }

      chunks.push(remaining.substring(0, splitIdx))
      remaining = remaining.substring(splitIdx).trimStart()
    }

    return chunks
  }

  private async synthesizeChunk(
    text: string,
    voice: string,
    speed: number = 1.0
  ): Promise<{ audioPath: string; usedVoice: string }> {
    const speech = await this.requestSpeechWithFallback(text, voice, speed)
    const outputPath = join(this.getTempDir(), `tts_${uuidv4()}.wav`)
    writeFileSync(outputPath, speech.buffer)
    return {
      audioPath: outputPath,
      usedVoice: speech.usedVoice
    }
  }

  async synthesize(
    voice: string,
    text: string,
    speed: number = 1.0
  ): Promise<{ audioPath: string }> {
    if (!getUcloudTtsApiKey()) {
      throw new Error('TTS API Key 未配置，请在设置页面填写 UCloud TTS API Key')
    }

    console.log(
      `[TTS] Synthesize: requestedVoice=${voice}, text="${this.truncateText(text, 40)}...", speed=${speed}`
    )

    const chunks = this.splitText(text)
    const audioParts: string[] = []
    let activeVoice = voice

    for (let index = 0; index < chunks.length; index++) {
      const { audioPath, usedVoice } = await this.synthesizeChunk(chunks[index], activeVoice, speed)
      audioParts.push(audioPath)
      if (index === 0 && usedVoice !== activeVoice) {
        activeVoice = usedVoice
        console.warn(
          `[TTS] Continuing synthesis with fallback voice, requested=${voice}, active=${activeVoice}`
        )
      }
    }

    if (audioParts.length === 1) {
      return { audioPath: audioParts[0] }
    }

    try {
      const outputPath = join(this.getTempDir(), `tts_merged_${uuidv4()}.wav`)
      await concatAudioFiles(audioParts, outputPath)
      return { audioPath: outputPath }
    } catch (err: any) {
      console.warn(`FFmpeg not available, returning first TTS chunk only: ${err?.message || err}`)
      return { audioPath: audioParts[0] }
    }
  }

  async uploadVoice(name: string, audioPath: string): Promise<VoiceInfo> {
    const form = new FormData()
    const fileExt = extname(audioPath) || '.wav'
    const mimeMap: Record<string, string> = {
      '.wav': 'audio/wav',
      '.mp3': 'audio/mpeg',
      '.m4a': 'audio/mp4',
      '.ogg': 'audio/ogg',
      '.flac': 'audio/flac',
      '.aac': 'audio/aac',
      '.webm': 'audio/webm'
    }

    form.append('speaker_file', readFileSync(audioPath), {
      filename: `${name}${fileExt}`,
      contentType: mimeMap[fileExt] || 'audio/wav'
    })
    form.append('model', getUcloudTtsModel())
    form.append('name', name)

    const resp = await axios.post(`${this.getBaseUrl()}/audio/voice/upload`, form, {
      headers: {
        Authorization: `Bearer ${getUcloudTtsApiKey()}`,
        ...form.getHeaders()
      },
      httpsAgent: this.speechAgent,
      timeout: TTS_REQUEST_TIMEOUT_MS
    })

    this.invalidateVoiceListCache()

    const data = resp.data
    return {
      id: data.id || data.voice_id,
      name: data.name || name,
      expires_in_days: data.expires_in_days
    }
  }

  async listVoices(): Promise<VoiceInfo[]> {
    return this.listVoicesCached(true)
  }

  async deleteVoice(voiceId: string): Promise<void> {
    await axios.post(
      `${this.getBaseUrl()}/audio/voice/delete`,
      { id: voiceId },
      {
        headers: this.getHeaders(),
        httpsAgent: this.speechAgent,
        timeout: 15000
      }
    )

    this.invalidateVoiceListCache()
  }

  async getAllVoices(): Promise<VoiceInfo[]> {
    try {
      const cloned = await this.listVoicesCached(true)
      return [...PRESET_VOICES, ...cloned]
    } catch {
      return [...PRESET_VOICES]
    }
  }
}

export const ttsService = new TtsService()
