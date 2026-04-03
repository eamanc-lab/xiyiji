import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => [])
  },
  app: {
    getPath: vi.fn(() => 'D:\\yunyin\\XYJ2\\xiyiji\\.vitest'),
    getName: vi.fn(() => 'xiyiji'),
    whenReady: vi.fn(async () => undefined),
    quit: vi.fn()
  },
  ipcMain: {
    handle: vi.fn()
  }
}))

import { aiLoopService } from './ai-loop.service'
import { llmService } from './llm.service'
import { liveTranslationService } from './live-translation.service'
import { orderedGeneralizeService } from './ordered-generalize.service'
import { qwenService } from './qwen.service'
import { queueManager } from './queue.manager'
import { roomSessionService } from './room-session.service'
import { roomTemperatureService } from './room-temperature'

type SessionMap = Map<string, any>

const sessions = (roomSessionService as any).sessions as SessionMap

function makeSession(overrides: Record<string, unknown> = {}): any {
  return {
    roomId: 'room-1',
    activeLinkId: 'link-1',
    generalScript: '通用开场欢迎大家来到直播间。',
    allLinks: [
      {
        id: 'link-1',
        slotNo: 1,
        name: '蜂蜜礼盒',
        content: [
          '蜂蜜礼盒今天只要99元，500g家庭装，送礼自用都合适。',
          '下单还是1号链接，数量不多，直播间想要的直接拍。'
        ].join('\n\n')
      }
    ],
    shortcuts: ['喜欢的直接拍', '这个价格真不多见'],
    forbiddenWords: [],
    recentResponses: [],
    ...overrides
  }
}

function buildBatchContext(danmaku: string[], playingText = ''): any {
  return {
    aiSystemPrompt: '',
    generalScript: '通用开场欢迎大家来到直播间。',
    allLinks: [],
    activeLink: null,
    shortcuts: [],
    forbiddenWords: [],
    recentDanmaku: danmaku,
    recentResponses: [],
    playingText,
    batchSize: 8,
    outputLanguage: 'zh-CN',
    temperature: 'cold',
    temperatureHint: '',
    giftSummary: '',
    priorityDanmaku: [],
    isDanmakuResponse: false
  }
}

function resetQueue(): void {
  queueManager.stop()
  ;(queueManager as any).items = []
}

function resetAiLoopState(): void {
  const loop = aiLoopService as any
  if (loop.timer) clearInterval(loop.timer)
  if (loop.refillTimer) clearTimeout(loop.refillTimer)
  loop.timer = null
  loop.refillTimer = null
  loop.activeRoomId = null
  loop.generating = false
  loop.pendingEvents = []
  loop.priorityQueue = []
  loop.giftAccumulator = []
  loop.danmakuResponseCooldownUntil = 0
  loop.danmakuTriggered = false
  loop.fallbackStates.clear()
  loop.rotation = {
    enabled: false,
    batchesPerProduct: 1,
    currentIndex: 0,
    batchesCompleted: 0,
    sortedLinkIds: [],
    interruptedFromIndex: null,
    interruptLinkId: null,
    interruptBatchesDone: 0,
    interruptPendingFirstBatch: false
  }
}

function pushQueueItem(role: 'mainline' | 'interaction' | 'manual' | 'shortcut', aiMode?: string): void {
  queueManager.push({
    text: `${role}-${aiMode || 'none'}`,
    translatedText: null,
    audioPath: 'ready.wav',
    source: role === 'shortcut' ? 'shortcut' : (role === 'manual' ? 'manual' : 'ai'),
    meta: {
      role,
      aiMode: aiMode || null
    }
  })
}

beforeEach(() => {
  sessions.clear()
  orderedGeneralizeService.resetRoom('room-1')
  resetQueue()
  resetAiLoopState()
})

afterEach(() => {
  vi.restoreAllMocks()
  sessions.clear()
  orderedGeneralizeService.resetRoom('room-1')
  resetQueue()
  resetAiLoopState()
})

describe('room session and ordered generalize flow', () => {
  it('prefers the active link script and falls back to the general script', () => {
    sessions.set('room-1', makeSession())

    expect(roomSessionService.getCurrentScriptSource('room-1')?.key).toBe('link:link-1')

    sessions.get('room-1')!.allLinks[0].content = '   '
    expect(roomSessionService.getCurrentScriptSource('room-1')?.key).toBe('general')
  })

  it('preserves protected facts, advances sequentially, and translates after rewriting', async () => {
    sessions.set('room-1', makeSession())

    vi.spyOn(roomSessionService, 'getAiSettings').mockReturnValue({
      aiSystemPrompt: '保持热情但不要改事实',
      aiMode: 'ordered_generalize_ai',
      outputLanguage: 'zh-CN'
    })

    const source = roomSessionService.getCurrentScriptSource('room-1')
    expect(source?.key).toBe('link:link-1')

    const helper = orderedGeneralizeService as any
    const firstUnit = '蜂蜜礼盒今天只要99元，500g家庭装，送礼自用都合适。'
    const secondUnit = '下单还是1号链接，数量不多，直播间想要的直接拍。'
    const firstPlaceholder = helper.applyProtectedTokens(firstUnit, helper.protectText(firstUnit, source))
    const secondPlaceholder = helper.applyProtectedTokens(secondUnit, helper.protectText(secondUnit, source))

    vi.spyOn(llmService, 'chat')
      .mockResolvedValueOnce({
        model: 'mock',
        content: [
          `1|||宝贝们先把这句重点记住，${firstPlaceholder}，今天在直播间安排下来真的更划算更省心。`,
          `2|||我把下单信息顺着给大家再说一遍，${secondPlaceholder}，看上的朋友现在就直接拍别拖。`
        ].join('\n')
      })
      .mockResolvedValueOnce({
        model: 'mock',
        content: `1|||我换个更直接的说法提醒你们，${firstPlaceholder}，这会儿在直播间入手会更稳更合适。`
      })
      .mockResolvedValueOnce({
        model: 'mock',
        content: `1|||姐妹们把这个重点听清楚，${firstPlaceholder}，今天在直播间看上就可以放心安排。`
      })

    vi.spyOn(liveTranslationService, 'translateLines').mockImplementation(async (lines, targetLang) => (
      lines.map((line) => `${targetLang.toUpperCase()}:${line}`)
    ))

    const batch1 = await orderedGeneralizeService.getNextBatch('room-1', 2, 'zh-CN')
    expect(batch1).toHaveLength(2)
    expect(batch1[0].round).toBe(1)
    expect(batch1[0].unitIndex).toBe(0)
    expect(batch1[1].round).toBe(1)
    expect(batch1[1].unitIndex).toBe(1)
    expect(batch1[0].text).toContain('99元')
    expect(batch1[0].text).toContain('500g')
    expect(batch1[0].text).toContain('送礼')
    expect(batch1[0].text).toContain('蜂蜜礼盒')
    expect(batch1[0].text.length).toBeGreaterThanOrEqual(firstUnit.length)
    expect(batch1[0].text).not.toBe(firstUnit)
    expect(batch1[1].text).toContain('1号链接')
    expect(batch1[1].text).toContain('数量不多')

    const batch2 = await orderedGeneralizeService.getNextBatch('room-1', 1, 'zh-CN')
    expect(batch2).toHaveLength(1)
    expect(batch2[0].round).toBe(2)
    expect(batch2[0].unitIndex).toBe(0)
    expect(batch2[0].text).toContain('99元')
    expect(batch2[0].text).not.toBe(batch1[0].text)

    orderedGeneralizeService.resetRoom('room-1')
    const batchEn = await orderedGeneralizeService.getNextBatch('room-1', 1, 'en')
    expect(batchEn).toHaveLength(1)
    expect(batchEn[0].text.startsWith('EN:')).toBe(true)
    expect(batchEn[0].translatedText).toContain('99元')
  })
})

describe('ordered generalize queue mapping', () => {
  it('keeps Chinese translatedText for ordered_generalize_ai non-Chinese mainline items', async () => {
    vi.spyOn(roomSessionService, 'getAiSettings').mockReturnValue({
      aiSystemPrompt: '',
      aiMode: 'ordered_generalize_ai',
      outputLanguage: 'en'
    })
    vi.spyOn(orderedGeneralizeService, 'getNextBatch').mockResolvedValue([
      {
        text: 'Buy now for ninety nine dollars',
        translatedText: '现在下单就是九十九元',
        sourceKey: 'link:link-1',
        unitIndex: 0,
        unitTotal: 2,
        round: 1
      }
    ])

    const batch = await (aiLoopService as any).getNextOrderedGeneralizeBatch('room-1')

    expect(batch).toEqual([
      {
        text: 'Buy now for ninety nine dollars',
        translatedText: '现在下单就是九十九元',
        meta: {
          role: 'mainline',
          aiMode: 'ordered_generalize_ai',
          scriptSourceKey: 'link:link-1',
          sequenceIndex: 1,
          sequenceTotal: 2,
          round: 1,
          preserveOrder: true
        }
      }
    ])
  })

  it('holds ordered_generalize_ai mainline items until the head audio is ready', () => {
    resetQueue()
    const items = queueManager.pushBatch([
      {
        text: '第一条',
        translatedText: null,
        audioPath: null,
        source: 'ai',
        meta: { role: 'mainline', aiMode: 'ordered_generalize_ai', preserveOrder: true }
      },
      {
        text: '第二条',
        translatedText: null,
        audioPath: null,
        source: 'ai',
        meta: { role: 'mainline', aiMode: 'ordered_generalize_ai', preserveOrder: true }
      },
      {
        text: '第三条',
        translatedText: null,
        audioPath: null,
        source: 'ai',
        meta: { role: 'mainline', aiMode: 'ordered_generalize_ai', preserveOrder: true }
      }
    ])

    queueManager.updateAudioPath(items[2].id, 'third.wav')
    queueManager.updateAudioPath(items[1].id, 'second.wav')

    expect(queueManager.next()).toBeNull()

    queueManager.updateAudioPath(items[0].id, 'first.wav')
    expect(queueManager.next()?.id).toBe(items[0].id)

    queueManager.markCurrentDone()
    expect(queueManager.next()?.id).toBe(items[1].id)
  })

  it('splits oversized ordered_generalize script units into speech-sized chunks', () => {
    const helper = orderedGeneralizeService as any
    const units = helper.splitScriptUnits(
      '苹果一定要选红的脆的不要面的，洗干净以后直接切块，不用去皮，先把这一句记住。' +
      '红枣要用干红枣，新鲜的不要，清洗干净以后再剪开，这样更容易把味道煮出来。' +
      '山楂要选去核去籽的干山楂片，别图省事乱买，比例一定要按前面讲的来。'
    )

    expect(units.length).toBeGreaterThan(1)
    expect(Math.max(...units.map((unit: string) => unit.length))).toBeLessThanOrEqual(120)
    expect(units[0]).toContain('苹果')
    expect(units[1]).toContain('红枣')
  })
})

describe('queue protection rules', () => {
  it('keeps mainline items in no_ai while clearing only interaction items', () => {
    resetQueue()
    pushQueueItem('mainline', 'no_ai')
    pushQueueItem('interaction', 'no_ai')
    pushQueueItem('manual')

    ;(aiLoopService as any).prepareQueueForInteraction('no_ai')

    const queue = queueManager.getDisplayQueue()
    expect(queue.some((item) => item.meta?.role === 'mainline')).toBe(true)
    expect(queue.some((item) => item.meta?.role === 'interaction')).toBe(false)
    expect(queue.some((item) => item.meta?.role === 'manual')).toBe(true)
  })

  it('drops pending generated items for full_ai interactions', () => {
    resetQueue()
    pushQueueItem('mainline', 'full_ai')
    pushQueueItem('interaction', 'full_ai')
    pushQueueItem('manual')

    ;(aiLoopService as any).prepareQueueForInteraction('full_ai')

    const queue = queueManager.getDisplayQueue()
    expect(queue.some((item) => item.meta?.role === 'mainline')).toBe(false)
    expect(queue.some((item) => item.meta?.role === 'interaction')).toBe(false)
    expect(queue.some((item) => item.meta?.role === 'manual')).toBe(true)
  })

  it('clears generated items on link switch but keeps manual and shortcut entries', () => {
    resetQueue()
    pushQueueItem('mainline', 'ordered_generalize_ai')
    pushQueueItem('interaction', 'ordered_generalize_ai')
    pushQueueItem('shortcut')
    pushQueueItem('manual')

    aiLoopService.clearPendingGenerated()

    const queue = queueManager.getDisplayQueue()
    expect(queue.some((item) => item.meta?.role === 'mainline')).toBe(false)
    expect(queue.some((item) => item.meta?.role === 'interaction')).toBe(false)
    expect(queue.some((item) => item.meta?.role === 'shortcut')).toBe(true)
    expect(queue.some((item) => item.meta?.role === 'manual')).toBe(true)
  })

  it('does not write English text into the Chinese translation field when back-translation fails', async () => {
    const item = queueManager.push({
      text: 'Buy now for ninety nine dollars',
      translatedText: null,
      audioPath: 'ready.wav',
      source: 'ai',
      meta: { role: 'interaction', aiMode: 'ordered_generalize_ai' }
    })

    vi.spyOn(liveTranslationService, 'translateLines').mockResolvedValue([
      'Buy now for ninety nine dollars'
    ])

    ;(aiLoopService as any).fillMissingChineseTranslations('en', [
      {
        id: item.id,
        line: {
          text: 'Buy now for ninety nine dollars',
          translatedText: null,
          meta: null
        }
      }
    ])

    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(queueManager.getDisplayQueue()[0]?.translatedText).toBeNull()
  })

  it('writes a real Chinese translation when back-translation succeeds', async () => {
    const item = queueManager.push({
      text: 'Buy now for ninety nine dollars',
      translatedText: null,
      audioPath: 'ready.wav',
      source: 'ai',
      meta: { role: 'interaction', aiMode: 'ordered_generalize_ai' }
    })

    vi.spyOn(liveTranslationService, 'translateLines').mockResolvedValue([
      '现在下单就是九十九元'
    ])

    ;(aiLoopService as any).fillMissingChineseTranslations('en', [
      {
        id: item.id,
        line: {
          text: 'Buy now for ninety nine dollars',
          translatedText: null,
          meta: null
        }
      }
    ])

    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(queueManager.getDisplayQueue()[0]?.translatedText).toBe('现在下单就是九十九元')
  })
})

describe('ai loop mode branching', () => {
  it('uses fallback looping for no_ai when there is no interaction signal', async () => {
    vi.spyOn(roomSessionService, 'getSession').mockReturnValue(makeSession())
    vi.spyOn(roomSessionService, 'getAiSettings').mockReturnValue({
      aiSystemPrompt: '',
      aiMode: 'no_ai',
      outputLanguage: 'zh-CN'
    })
    vi.spyOn(roomTemperatureService, 'getTemperature').mockReturnValue('warm')
    vi.spyOn(roomSessionService, 'buildBatchContext').mockImplementation((roomId, danmaku, playingText) => {
      expect(roomId).toBe('room-1')
      return buildBatchContext(danmaku, playingText)
    })

    const fallbackSpy = vi.spyOn(aiLoopService as any, 'getNextFallbackBatch').mockResolvedValue([
      { text: '原文循环结果', translatedText: null, meta: null }
    ])
    const orderedSpy = vi.spyOn(aiLoopService as any, 'getNextOrderedGeneralizeBatch').mockResolvedValue([
      { text: '顺序泛化结果', translatedText: null, meta: null }
    ])
    const qwenSpy = vi.spyOn(qwenService, 'generateBatch').mockResolvedValue(['AI 主线结果'])
    const submitBatchSpy = vi.spyOn(aiLoopService as any, 'submitBatch').mockResolvedValue(undefined)
    const submitPrioritySpy = vi.spyOn(aiLoopService as any, 'submitPriority').mockResolvedValue(undefined)

    await (aiLoopService as any).generate('room-1')

    expect(fallbackSpy).toHaveBeenCalledOnce()
    expect(fallbackSpy.mock.calls[0][2]).toBe('no_ai')
    expect(orderedSpy).not.toHaveBeenCalled()
    expect(qwenSpy).not.toHaveBeenCalled()
    expect(submitBatchSpy).toHaveBeenCalledOnce()
    expect(submitPrioritySpy).not.toHaveBeenCalled()
  })

  it('uses ordered generalization for ordered_generalize_ai when there is no interaction signal', async () => {
    vi.spyOn(roomSessionService, 'getSession').mockReturnValue(makeSession())
    vi.spyOn(roomSessionService, 'getAiSettings').mockReturnValue({
      aiSystemPrompt: '',
      aiMode: 'ordered_generalize_ai',
      outputLanguage: 'zh-CN'
    })
    vi.spyOn(roomTemperatureService, 'getTemperature').mockReturnValue('warm')
    vi.spyOn(roomSessionService, 'buildBatchContext').mockImplementation((_roomId, danmaku, playingText) => (
      buildBatchContext(danmaku, playingText)
    ))

    const fallbackSpy = vi.spyOn(aiLoopService as any, 'getNextFallbackBatch').mockResolvedValue([
      { text: '原文循环结果', translatedText: null, meta: null }
    ])
    const orderedSpy = vi.spyOn(aiLoopService as any, 'getNextOrderedGeneralizeBatch').mockResolvedValue([
      { text: '顺序泛化结果', translatedText: null, meta: null }
    ])
    const qwenSpy = vi.spyOn(qwenService, 'generateBatch').mockResolvedValue(['AI 主线结果'])
    const submitBatchSpy = vi.spyOn(aiLoopService as any, 'submitBatch').mockResolvedValue(undefined)

    await (aiLoopService as any).generate('room-1')

    expect(orderedSpy).toHaveBeenCalledOnce()
    expect(fallbackSpy).not.toHaveBeenCalled()
    expect(qwenSpy).not.toHaveBeenCalled()
    expect(submitBatchSpy).toHaveBeenCalledOnce()
  })

  it('still routes no_ai comments through the AI interaction branch', async () => {
    vi.spyOn(roomSessionService, 'getSession').mockReturnValue(makeSession())
    vi.spyOn(roomSessionService, 'getAiSettings').mockReturnValue({
      aiSystemPrompt: '',
      aiMode: 'no_ai',
      outputLanguage: 'zh-CN'
    })
    vi.spyOn(roomTemperatureService, 'getTemperature').mockReturnValue('warm')
    vi.spyOn(roomSessionService, 'buildBatchContext').mockImplementation((_roomId, danmaku, playingText) => (
      buildBatchContext(danmaku, playingText)
    ))

    const loop = aiLoopService as any
    loop.pendingEvents = [
      {
        type: 'comment',
        nickname: '小王',
        content: '这个多少钱',
        timestamp: Date.now(),
        userId: '1'
      }
    ]
    loop.danmakuTriggered = true

    const fallbackSpy = vi.spyOn(aiLoopService as any, 'getNextFallbackBatch').mockResolvedValue([
      { text: '原文循环结果', translatedText: null, meta: null }
    ])
    const orderedSpy = vi.spyOn(aiLoopService as any, 'getNextOrderedGeneralizeBatch').mockResolvedValue([
      { text: '顺序泛化结果', translatedText: null, meta: null }
    ])
    const qwenSpy = vi.spyOn(qwenService, 'generateBatch').mockImplementation(async (ctx) => {
      expect(ctx.isDanmakuResponse).toBe(true)
      expect(ctx.batchSize).toBe(2)
      expect(ctx.recentDanmaku).toEqual(['小王: 这个多少钱'])
      return ['小王今天直播间是99元', '看好的直接去1号链接下单']
    })
    const submitBatchSpy = vi.spyOn(aiLoopService as any, 'submitBatch').mockResolvedValue(undefined)
    const submitPrioritySpy = vi.spyOn(aiLoopService as any, 'submitPriority').mockResolvedValue(undefined)

    await loop.generate('room-1')

    expect(qwenSpy).toHaveBeenCalledOnce()
    expect(fallbackSpy).not.toHaveBeenCalled()
    expect(orderedSpy).not.toHaveBeenCalled()
    expect(submitPrioritySpy).toHaveBeenCalledOnce()
    expect(submitBatchSpy).not.toHaveBeenCalled()
  })
})
