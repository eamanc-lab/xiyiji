import { llmService, type ChatMessage } from './llm.service'

const LANGUAGE_NAMES: Record<string, string> = {
  'zh-CN': 'Simplified Chinese',
  en: 'English',
  es: 'Spanish'
}

class LiveTranslationService {
  private readonly cache = new Map<string, string>()
  private readonly batchSize = 20

  async translateSingleLine(text: string, targetLang: string): Promise<string> {
    const [translated] = await this.translateLines([text], targetLang)
    return translated !== undefined ? translated : text
  }

  async translateLines(lines: string[], targetLang: string): Promise<string[]> {
    if (lines.length === 0) return []

    const normalized = lines.map((line) => String(line || '').trim())
    const results = [...normalized]
    const pending: Array<{ index: number; text: string }> = []

    normalized.forEach((text, index) => {
      if (!text) {
        results[index] = ''
        return
      }

      const cacheKey = this.getCacheKey(text, targetLang)
      const cached = this.cache.get(cacheKey)
      if (cached) {
        results[index] = cached
        return
      }

      pending.push({ index, text })
    })

    for (let i = 0; i < pending.length; i += this.batchSize) {
      const batch = pending.slice(i, i + this.batchSize)
      const translatedBatch = await this.translateBatch(
        batch.map((entry) => entry.text),
        targetLang
      )

      batch.forEach((entry, batchIndex) => {
        const translated = translatedBatch[batchIndex] !== undefined
          ? translatedBatch[batchIndex]
          : entry.text
        results[entry.index] = translated
        if (translated.trim()) {
          this.cache.set(this.getCacheKey(entry.text, targetLang), translated)
        }
      })
    }

    return results
  }

  private async translateBatch(lines: string[], targetLang: string): Promise<string[]> {
    if (lines.length === 0) return []

    const targetName = LANGUAGE_NAMES[targetLang] || targetLang
    let translated = await this.requestTranslation(lines, targetLang, targetName, false)

    if (targetLang === 'zh-CN') {
      const retryIndexes = lines
        .map((line, index) => this.isAcceptableChineseTranslation(line, translated[index]) ? -1 : index)
        .filter((index) => index >= 0)

      if (retryIndexes.length > 0) {
        const retried = await this.requestTranslation(
          retryIndexes.map((index) => lines[index]),
          targetLang,
          targetName,
          true
        )

        retryIndexes.forEach((lineIndex, retryIndex) => {
          translated[lineIndex] = retried[retryIndex]
        })
      }

      return lines.map((line, index) => {
        const candidate = translated[index]
        return this.isAcceptableChineseTranslation(line, candidate)
          ? String(candidate).trim()
          : ''
      })
    }

    return lines.map((line, index) => {
      const candidate = String(translated[index] || '').trim()
      return candidate || line
    })
  }

  private async requestTranslation(
    lines: string[],
    targetLang: string,
    targetName: string,
    strictChinese: boolean
  ): Promise<string[]> {
    const numbered = lines.map((line, index) => `${index + 1}. ${line}`).join('\n')

    try {
      const messages: ChatMessage[] = [
        {
          role: 'system',
          content: strictChinese
            ? `You are a professional translator for live-streaming scripts. ` +
              `Translate the following lines into natural Simplified Chinese. ` +
              `Every output line MUST be Simplified Chinese. ` +
              `Do NOT repeat the source line in English, Spanish, or any other non-Chinese language. ` +
              `Preserve all prices, numbers, quantities, specifications, model names, and factual details. ` +
              `Output ONLY the translated lines, one per line, in the same order, with no numbering or explanation.`
            : `You are a professional translator for live-streaming scripts. ` +
              `Translate the following lines to ${targetName}. ` +
              `Maintain the original tone and sales style. ` +
              `Output ONLY the translated lines, one per line, in the same order. ` +
              `Do NOT include line numbers or any extra explanation.`
        },
        {
          role: 'user',
          content: numbered
        }
      ]

      const resp = await llmService.chat(messages, undefined, {
        max_tokens: 4096,
        temperature: strictChinese ? 0.1 : 0.2
      })

      return resp.content
        .split(/\r?\n/)
        .map((line) => line.replace(/^\d+[\.\u3001\)\-:]\s*/, '').trim())
        .filter((line) => line.length > 0)
    } catch (err: any) {
      console.error(`[LiveTranslation] translateBatch failed (${targetLang}):`, err.message)
      return lines
    }
  }

  private isAcceptableChineseTranslation(source: string, translated: string | undefined): boolean {
    const sourceText = String(source || '').trim()
    const translatedText = String(translated || '').trim()

    if (!translatedText) return false
    if (translatedText === sourceText) return false
    return /[\u4e00-\u9fff]/.test(translatedText)
  }

  private getCacheKey(text: string, targetLang: string): string {
    return `${targetLang}::${text}`
  }
}

export const liveTranslationService = new LiveTranslationService()
