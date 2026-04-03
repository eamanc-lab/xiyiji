import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => [])
  }
}))

import { llmService } from './llm.service'
import { liveTranslationService } from './live-translation.service'

afterEach(() => {
  vi.restoreAllMocks()
  ;(liveTranslationService as any).cache.clear()
})

describe('live translation service', () => {
  it('retries zh-CN back-translation when the first pass stays in English', async () => {
    vi.spyOn(llmService, 'chat')
      .mockResolvedValueOnce({
        model: 'mock',
        content: 'Buy now for ninety nine dollars'
      })
      .mockResolvedValueOnce({
        model: 'mock',
        content: '现在下单就是九十九元'
      })

    const translated = await liveTranslationService.translateLines(
      ['Buy now for ninety nine dollars'],
      'zh-CN'
    )

    expect(translated).toEqual(['现在下单就是九十九元'])
    expect(llmService.chat).toHaveBeenCalledTimes(2)
  })

  it('returns empty zh-CN translation when both passes fail to produce Chinese', async () => {
    vi.spyOn(llmService, 'chat')
      .mockResolvedValueOnce({
        model: 'mock',
        content: 'Buy now for ninety nine dollars'
      })
      .mockResolvedValueOnce({
        model: 'mock',
        content: 'Buy now for ninety nine dollars'
      })

    const translated = await liveTranslationService.translateLines(
      ['Buy now for ninety nine dollars'],
      'zh-CN'
    )

    expect(translated).toEqual([''])
    expect(llmService.chat).toHaveBeenCalledTimes(2)
  })

  it('keeps normal non-Chinese translation fallback behavior unchanged', async () => {
    vi.spyOn(llmService, 'chat').mockRejectedValue(new Error('network'))

    const translated = await liveTranslationService.translateLines(
      ['直播间现在下单更划算'],
      'en'
    )

    expect(translated).toEqual(['直播间现在下单更划算'])
    expect(llmService.chat).toHaveBeenCalledTimes(1)
  })
})
