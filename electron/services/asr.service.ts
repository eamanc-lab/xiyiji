import axios from 'axios'
import { getDashscopeApiKey, getDashscopeBaseUrl } from '../config'
import { readFileSync } from 'fs'
import { basename } from 'path'
import FormData from 'form-data'

export interface AsrSegment {
  text: string
  start: number
  end: number
  speaker_id?: string
}

export interface AsrResult {
  segments: AsrSegment[]
  fullText: string
  duration: number
}

class AsrService {
  private getHeaders() {
    return {
      Authorization: `Bearer ${getDashscopeApiKey()}`
    }
  }

  private getBaseUrl() {
    return getDashscopeBaseUrl()
  }

  async isAvailable(): Promise<boolean> {
    try {
      const apiKey = getDashscopeApiKey()
      if (!apiKey) return false
      // Try to get upload policy as a connectivity check
      await axios.get(`${this.getBaseUrl()}/uploads?action=getPolicy&model=fun-asr`, {
        headers: this.getHeaders(),
        timeout: 5000
      })
      return true
    } catch {
      return false
    }
  }

  /**
   * Step 1: Get OSS upload policy from DashScope
   */
  private async getUploadPolicy(): Promise<{
    upload_url: string
    upload_dir: string
    oss_access_key_id: string
    policy: string
    signature: string
    x_oss_object_acl: string
    x_oss_forbid_overwrite: string
  }> {
    const resp = await axios.get(`${this.getBaseUrl()}/uploads?action=getPolicy&model=fun-asr`, {
      headers: this.getHeaders(),
      timeout: 15000
    })

    if (resp.data?.data) {
      return resp.data.data
    }
    throw new Error('Failed to get upload policy: ' + JSON.stringify(resp.data))
  }

  /**
   * Step 2: Upload audio file to OSS
   */
  private async uploadToOss(
    filePath: string,
    policy: Awaited<ReturnType<typeof this.getUploadPolicy>>
  ): Promise<string> {
    const fileName = basename(filePath)
    const ossKey = `${policy.upload_dir}/${fileName}`

    const form = new FormData()
    form.append('OSSAccessKeyId', policy.oss_access_key_id)
    form.append('policy', policy.policy)
    form.append('signature', policy.signature)
    form.append('key', ossKey)
    form.append('x-oss-object-acl', policy.x_oss_object_acl)
    form.append('x-oss-forbid-overwrite', policy.x_oss_forbid_overwrite)
    form.append('success_action_status', '200')
    form.append('file', readFileSync(filePath), { filename: fileName })

    await axios.post(policy.upload_url, form, {
      headers: form.getHeaders(),
      timeout: 120000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    })

    return `oss://${policy.upload_url.replace('https://', '').split('.')[0]}/${ossKey}`
  }

  /**
   * Step 3: Submit transcription task
   */
  private async submitTask(fileUrl: string): Promise<string> {
    const resp = await axios.post(
      `${this.getBaseUrl()}/services/audio/asr/transcription`,
      {
        model: 'fun-asr',
        input: { file_urls: [fileUrl] },
        parameters: {
          language_hints: ['zh'],
          diarization_enabled: true,
          speaker_count: 6,
          enable_words: true
        }
      },
      {
        headers: {
          ...this.getHeaders(),
          'Content-Type': 'application/json',
          'X-DashScope-Async': 'enable'
        },
        timeout: 30000
      }
    )

    const taskId = resp.data?.output?.task_id
    if (!taskId) {
      throw new Error('Failed to submit ASR task: ' + JSON.stringify(resp.data))
    }
    return taskId
  }

  /**
   * Step 4: Poll task status until completion
   */
  private async pollTask(
    taskId: string,
    onProgress?: (status: string) => void
  ): Promise<any> {
    const maxAttempts = 300 // ~10 minutes at 2s intervals
    let attempts = 0

    while (attempts < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, 2000))
      attempts++

      const resp = await axios.get(`${this.getBaseUrl()}/tasks/${taskId}`, {
        headers: this.getHeaders(),
        timeout: 15000
      })

      const output = resp.data?.output
      if (!output) continue

      const status = output.task_status
      onProgress?.(status)

      if (status === 'SUCCEEDED') {
        return output
      } else if (status === 'FAILED') {
        throw new Error(`ASR task failed: ${output.message || 'Unknown error'}`)
      }
      // PENDING or RUNNING - continue polling
    }

    throw new Error('ASR task timed out after 10 minutes')
  }

  /**
   * Step 5: Download and parse transcription result
   */
  private async parseResult(output: any): Promise<AsrResult> {
    const results = output.results
    if (!results || results.length === 0) {
      return { segments: [], fullText: '', duration: 0 }
    }

    // The result contains a URL to the transcription JSON
    const transcriptionUrl = results[0]?.transcription_url
    if (!transcriptionUrl) {
      return { segments: [], fullText: '', duration: 0 }
    }

    const resp = await axios.get(transcriptionUrl, { timeout: 30000 })
    const data = resp.data

    // Parse the transcription result
    const transcripts = data?.transcripts || []
    const segments: AsrSegment[] = []
    let fullText = ''

    for (const transcript of transcripts) {
      if (transcript.sentences) {
        for (const sentence of transcript.sentences) {
          segments.push({
            text: sentence.text || '',
            start: sentence.begin_time || 0,
            end: sentence.end_time || 0,
            speaker_id: sentence.speaker_id?.toString()
          })
          fullText += sentence.text || ''
        }
      } else if (transcript.text) {
        fullText += transcript.text
        segments.push({
          text: transcript.text,
          start: 0,
          end: 0
        })
      }
    }

    const duration = segments.length > 0
      ? Math.max(...segments.map((s) => s.end)) / 1000
      : 0

    return { segments, fullText, duration }
  }

  /**
   * Full transcription pipeline: upload → submit → poll → parse
   */
  async transcribe(
    audioPath: string,
    onProgress?: (status: string) => void
  ): Promise<AsrResult> {
    if (!getDashscopeApiKey()) {
      throw new Error('ASR API Key 未配置，请在设置页面填写 DashScope API Key')
    }
    let lastError: Error | null = null
    const maxRetries = 3

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        onProgress?.('uploading')

        // Step 1: Get upload policy
        const policy = await this.getUploadPolicy()

        // Step 2: Upload to OSS
        const fileUrl = await this.uploadToOss(audioPath, policy)

        onProgress?.('submitted')

        // Step 3: Submit task
        const taskId = await this.submitTask(fileUrl)

        // Step 4: Poll until done
        const output = await this.pollTask(taskId, onProgress)

        onProgress?.('parsing')

        // Step 5: Parse result
        return await this.parseResult(output)
      } catch (err: any) {
        lastError = err
        console.error(`ASR attempt ${attempt + 1} failed:`, err.message)

        if (attempt < maxRetries - 1) {
          // Exponential backoff: 2s, 4s, 8s
          await new Promise((resolve) => setTimeout(resolve, 2000 * Math.pow(2, attempt)))
        }
      }
    }

    throw lastError || new Error('ASR transcription failed after retries')
  }
}

export const asrService = new AsrService()
