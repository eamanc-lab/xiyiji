import axios from 'axios'
import { getDashscopeApiKey, getDashscopeBaseUrl } from '../config'
import { BrowserWindow } from 'electron'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface LlmResponse {
  content: string
  model: string
  usage?: {
    input_tokens: number
    output_tokens: number
    total_tokens: number
  }
}

// Model fallback order
const MODEL_FALLBACK = ['qwen-turbo-latest', 'qwen-plus', 'qwen-turbo']

class LlmService {
  private getHeaders() {
    return {
      Authorization: `Bearer ${getDashscopeApiKey()}`,
      'Content-Type': 'application/json'
    }
  }

  private getEndpoint() {
    return `${getDashscopeBaseUrl()}/services/aigc/text-generation/generation`
  }

  async isAvailable(): Promise<boolean> {
    try {
      const apiKey = getDashscopeApiKey()
      return !!apiKey
    } catch {
      return false
    }
  }

  /**
   * Send a chat message and get a response (non-streaming).
   * Tries models in fallback order.
   */
  async chat(
    messages: ChatMessage[],
    model?: string,
    options?: { max_tokens?: number; temperature?: number }
  ): Promise<LlmResponse> {
    if (!getDashscopeApiKey()) {
      throw new Error('LLM API Key 未配置，请在设置页面填写 DashScope API Key')
    }
    const models = model ? [model] : MODEL_FALLBACK
    let lastError: Error | null = null

    for (const m of models) {
      try {
        const resp = await axios.post(
          this.getEndpoint(),
          {
            model: m,
            input: { messages },
            parameters: {
              result_format: 'message',
              max_tokens: options?.max_tokens ?? 2048,
              temperature: options?.temperature ?? 0.7,
              top_p: 0.9
            }
          },
          {
            headers: this.getHeaders(),
            timeout: 60000
          }
        )

        const output = resp.data?.output
        if (!output) {
          throw new Error('Empty response from LLM')
        }

        const choice = output.choices?.[0]
        const content = choice?.message?.content || output.text || ''

        return {
          content,
          model: m,
          usage: resp.data?.usage
            ? {
                input_tokens: resp.data.usage.input_tokens || 0,
                output_tokens: resp.data.usage.output_tokens || 0,
                total_tokens: resp.data.usage.total_tokens || 0
              }
            : undefined
        }
      } catch (err: any) {
        lastError = err
        console.error(`LLM model ${m} failed:`, err.message)
        // If it's not a model-related error, don't try other models
        if (err.response?.status === 401 || err.response?.status === 403) {
          throw err
        }
      }
    }

    throw lastError || new Error('All LLM models failed')
  }

  /**
   * Send a chat message with streaming response (SSE).
   * Emits tokens to the renderer via IPC.
   */
  async chatStream(
    messages: ChatMessage[],
    model?: string
  ): Promise<LlmResponse> {
    if (!getDashscopeApiKey()) {
      throw new Error('LLM API Key 未配置，请在设置页面填写 DashScope API Key')
    }
    const m = model || MODEL_FALLBACK[0]

    const resp = await axios.post(
      this.getEndpoint(),
      {
        model: m,
        input: { messages },
        parameters: {
          result_format: 'message',
          max_tokens: 2048,
          temperature: 0.7,
          top_p: 0.9,
          incremental_output: true
        }
      },
      {
        headers: {
          ...this.getHeaders(),
          'X-DashScope-SSE': 'enable',
          Accept: 'text/event-stream'
        },
        responseType: 'stream',
        timeout: 120000
      }
    )

    let fullContent = ''
    const mainWindow = BrowserWindow.getAllWindows()[0]

    return new Promise<LlmResponse>((resolve, reject) => {
      let buffer = ''

      resp.data.on('data', (chunk: Buffer) => {
        buffer += chunk.toString()
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (line.startsWith('data:')) {
            try {
              const data = JSON.parse(line.substring(5).trim())
              const output = data?.output
              if (output) {
                const choice = output.choices?.[0]
                const token = choice?.message?.content || output.text || ''
                if (token) {
                  fullContent += token
                  mainWindow?.webContents.send('chat:token', {
                    token,
                    done: false
                  })
                }

                // Check if this is the final chunk
                if (output.finish_reason === 'stop' || choice?.finish_reason === 'stop') {
                  mainWindow?.webContents.send('chat:token', {
                    token: '',
                    done: true
                  })
                }
              }
            } catch {
              // Skip malformed JSON lines
            }
          }
        }
      })

      resp.data.on('end', () => {
        resolve({
          content: fullContent,
          model: m
        })
      })

      resp.data.on('error', (err: Error) => {
        reject(err)
      })
    })
  }
}

export const llmService = new LlmService()
