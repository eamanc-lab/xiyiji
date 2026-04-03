import { llmService, type ChatMessage } from './llm.service'
import { liveTranslationService } from './live-translation.service'
import { roomSessionService, type ScriptSourceContext } from './room-session.service'

interface ProtectedToken {
  token: string
  value: string
  occurrences: number
}

interface PreparedRewriteItem {
  order: number
  unitIndex: number
  unitTotal: number
  round: number
  sourceText: string
  placeholderText: string
  protectedTokens: ProtectedToken[]
  recentVariants: string[]
}

interface OrderedSourceState {
  signature: string
  units: string[]
  nextIndex: number
  round: number
  recentVariants: Map<number, string[]>
}

export interface OrderedGeneralizeLine {
  text: string
  translatedText: string | null
  sourceKey: string
  unitIndex: number
  unitTotal: number
  round: number
}

const PROTECTED_PATTERNS = [
  /(?:¥|￥|人民币|RMB)?\s*\d+(?:\.\d+)?\s*(?:元|块|w|万|美元|美金|欧元|刀)/gi,
  /\d+(?:\.\d+)?\s*%/g,
  /\d+(?:\.\d+)?\s*折/g,
  /\d+号链接/g,
  /\d+(?:\.\d+)?\s*(?:kg|g|克|斤|ml|mL|ML|l|L|升|毫升|cm|mm|m|米|寸|英寸|件|套|盒|包|瓶|支|片|袋|台|个|双|只|颗|天|周|月|年|小时|分钟|秒)/gi,
  /(?:买\d+送\d+|第\d+件|第\d+单|满\d+(?:\.\d+)?(?:元|件)|减\d+(?:\.\d+)?(?:元|块)|立减\d+(?:\.\d+)?(?:元|块)|券后\d+(?:\.\d+)?(?:元|块))/g,
  /\d{2,4}[年\/\-.]\d{1,2}(?:[月\/\-.]\d{1,2}日?)?/g,
  /\d{1,2}:\d{2}/g,
  /[A-Za-z]{1,6}-?\d{2,}[A-Za-z0-9-]*/g
]

const CONTEXT_TOKENS = [
  '送礼', '自用', '通勤', '上班', '约会', '居家', '宿舍', '办公室',
  '出差', '旅行', '宝妈', '学生', '孕妇', '老人', '儿童', '男生',
  '女生', '家用', '户外', '敏感肌', '油皮', '干皮', '混油', '混干',
  '礼盒', '直播间', '日常', '秋冬', '春夏'
]

const ORDERED_UNIT_MIN_LEN = 18
const ORDERED_UNIT_TARGET_LEN = 72
const ORDERED_UNIT_MAX_LEN = 96
const ORDERED_UNIT_HARD_MAX_LEN = 120
const ORDERED_REWRITE_HARD_MAX_LEN = 128

class OrderedGeneralizeService {
  private roomStates = new Map<string, Map<string, OrderedSourceState>>()

  resetRoom(roomId: string): void {
    this.roomStates.delete(roomId)
  }

  async getNextBatch(
    roomId: string,
    count: number,
    outputLanguage: string
  ): Promise<OrderedGeneralizeLine[]> {
    const source = roomSessionService.getCurrentScriptSource(roomId)
    if (!source || !source.content.trim()) return []

    const state = this.getOrCreateState(roomId, source)
    if (state.units.length === 0) return []

    const planned = this.planBatch(state, source, count)
    const aiSettings = roomSessionService.getAiSettings(roomId)
    const rewrittenChinese = await this.rewriteBatch(roomId, source, planned, aiSettings.aiSystemPrompt)

    const translated = outputLanguage === 'zh-CN'
      ? rewrittenChinese
      : await liveTranslationService.translateLines(rewrittenChinese, outputLanguage)

    planned.forEach((item, index) => {
      const history = state.recentVariants.get(item.unitIndex) || []
      const current = rewrittenChinese[index]
      history.push(current)
      if (history.length > 4) history.shift()
      state.recentVariants.set(item.unitIndex, history)
    })

    const last = planned[planned.length - 1]
    state.nextIndex = (last.unitIndex + 1) % state.units.length
    state.round = last.unitIndex + 1 >= state.units.length ? last.round + 1 : last.round

    return planned.map((item, index) => ({
      text: translated[index] || rewrittenChinese[index] || item.sourceText,
      translatedText: outputLanguage === 'zh-CN' ? null : rewrittenChinese[index] || item.sourceText,
      sourceKey: source.key,
      unitIndex: item.unitIndex,
      unitTotal: item.unitTotal,
      round: item.round
    }))
  }

  private getOrCreateState(roomId: string, source: ScriptSourceContext): OrderedSourceState {
    let roomState = this.roomStates.get(roomId)
    if (!roomState) {
      roomState = new Map()
      this.roomStates.set(roomId, roomState)
    }

    const signature = `${source.key}::${source.content}`
    const existing = roomState.get(source.key)
    if (existing && existing.signature === signature) {
      return existing
    }

    const nextState: OrderedSourceState = {
      signature,
      units: this.splitScriptUnits(source.content),
      nextIndex: 0,
      round: 1,
      recentVariants: new Map()
    }

    roomState.set(source.key, nextState)
    return nextState
  }

  private splitScriptUnits(script: string): string[] {
    let units = script
      .split(/\n{2,}/)
      .map((line) => line.trim())
      .filter(Boolean)

    if (units.length < 3) {
      units = script
        .split(/\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 10)
    }

    if (units.length < 3) {
      const sentences = (script.match(/[^。！？!?；;\n]+[。！？!?；;\n]?/g) || [])
        .map((line) => line.trim())
        .filter(Boolean)
      units = this.mergeShortUnits(sentences)
    }

    const normalized = units
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter((line) => line.length >= 8)

    const expanded = normalized.flatMap((line) => this.chunkLongUnit(line))

    return this.mergeShortUnits(expanded)
      .flatMap((line) => this.chunkLongUnit(line))
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter((line) => line.length >= 8)
  }

  private mergeShortUnits(units: string[]): string[] {
    const merged: string[] = []
    let buffer = ''

    for (const unit of units) {
      if (!buffer) {
        buffer = unit
        continue
      }

      if ((buffer.length < ORDERED_UNIT_MIN_LEN || unit.length < 12) &&
        buffer.length + unit.length <= ORDERED_UNIT_MAX_LEN) {
        buffer += unit
        continue
      }

      merged.push(buffer)
      buffer = unit
    }

    if (buffer) merged.push(buffer)
    return merged
  }

  private chunkLongUnit(text: string): string[] {
    const normalized = text.replace(/\s+/g, ' ').trim()
    if (!normalized) return []
    if (normalized.length <= ORDERED_UNIT_HARD_MAX_LEN) return [normalized]

    const chunks: string[] = []
    let remaining = normalized

    while (remaining.length > ORDERED_UNIT_HARD_MAX_LEN) {
      const splitIdx = this.findUnitSplitIndex(remaining)
      const head = remaining.slice(0, splitIdx).trim()
      if (!head) break
      chunks.push(head)
      remaining = remaining.slice(splitIdx).trim()
    }

    if (remaining) {
      chunks.push(remaining)
    }

    return chunks
  }

  private findUnitSplitIndex(text: string): number {
    const upper = Math.min(text.length, ORDERED_UNIT_HARD_MAX_LEN)
    const preferredUpper = Math.min(upper, ORDERED_UNIT_MAX_LEN)
    const lower = Math.max(1, Math.min(ORDERED_UNIT_MIN_LEN, upper))

    for (let i = preferredUpper; i >= lower; i--) {
      if (/[。！？；!?;\n]/.test(text[i - 1] || '')) {
        return i
      }
    }

    for (let i = upper; i >= lower; i--) {
      if (/[，、,.]/.test(text[i - 1] || '')) {
        return i
      }
    }

    return upper
  }

  private getMaxRewriteLength(sourceLength: number): number {
    return Math.min(
      ORDERED_REWRITE_HARD_MAX_LEN,
      Math.max(sourceLength + 36, Math.round(sourceLength * 1.7))
    )
  }

  private planBatch(state: OrderedSourceState, source: ScriptSourceContext, count: number): PreparedRewriteItem[] {
    const planned: PreparedRewriteItem[] = []
    let unitIndex = state.nextIndex
    let round = state.round

    for (let order = 0; order < count; order++) {
      const sourceText = state.units[unitIndex]
      const protectedTokens = this.protectText(sourceText, source)
      const recentVariants = state.recentVariants.get(unitIndex) || []

      planned.push({
        order: order + 1,
        unitIndex,
        unitTotal: state.units.length,
        round,
        sourceText,
        placeholderText: this.applyProtectedTokens(sourceText, protectedTokens),
        protectedTokens,
        recentVariants
      })

      unitIndex += 1
      if (unitIndex >= state.units.length) {
        unitIndex = 0
        round += 1
      }
    }

    return planned
  }

  private async rewriteBatch(
    roomId: string,
    source: ScriptSourceContext,
    items: PreparedRewriteItem[],
    aiSystemPrompt: string
  ): Promise<string[]> {
    if (items.length === 0) return []

    const session = roomSessionService.getSession(roomId)
    const shortcutStyle = session?.shortcuts.slice(0, 5) || []

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: [
          '你是一名专业直播话术改写助手，只负责在不改变事实的前提下重写中文直播话术。',
          '你不能自由编故事，不能新增数字、规格、价格、赠品、场景、人群、承诺、产品信息。',
          '你必须逐条保留占位符如 [[P1]]，不能改写、删除、调换或新增占位符。',
          '改写目标是尽可能大幅度变化表达方式，但长度不能短于原句。',
          aiSystemPrompt.trim() ? `角色设定：${aiSystemPrompt.trim()}` : '',
          shortcutStyle.length > 0 ? `风格参考：\n${shortcutStyle.map((line, index) => `${index + 1}. ${line}`).join('\n')}` : '',
          `当前脚本来源：${source.name}`,
          '请严格按指定格式输出，不要解释。'
        ].filter(Boolean).join('\n\n')
      },
      {
        role: 'user',
        content: this.buildBatchPrompt(items)
      }
    ]

    try {
      const resp = await llmService.chat(messages, undefined, {
        max_tokens: 4096,
        temperature: 0.9
      })

      const parsed = this.parseBatchResponse(resp.content, items)
      if (parsed.every(Boolean)) {
        return parsed as string[]
      }
    } catch (err: any) {
      console.error('[OrderedGeneralize] batch rewrite failed:', err.message)
    }

    const recovered: string[] = []
    for (const item of items) {
      recovered.push(await this.rewriteSingle(roomId, source, item, aiSystemPrompt, shortcutStyle))
    }
    return recovered
  }

  private buildBatchPrompt(items: PreparedRewriteItem[]): string {
    const blocks = items.map((item) => {
      const protectedList = item.protectedTokens.length > 0
        ? item.protectedTokens.map((token) => `${token.token}=${token.value}`).join('；')
        : '无'
      const recent = item.recentVariants.length > 0
        ? item.recentVariants.slice(-2).join(' / ')
        : '无'

      return [
        `[${item.order}]`,
        `轮次：第${item.round}轮，第${item.unitIndex + 1}/${item.unitTotal}条`,
        `原句：${item.placeholderText}`,
        `必须保留的占位符：${protectedList}`,
        `最近版本（避免接近）：${recent}`,
        `最短长度：${item.sourceText.length}`,
        `最长长度：${this.getMaxRewriteLength(item.sourceText.length)}`
      ].join('\n')
    })

    return [
      '请逐条改写下面的话术。',
      '硬规则：',
      '1. 必须保留所有占位符，并保持占位符出现次数不变。',
      '2. 不得改变任何事实、价格、数量、规格、型号、日期、赠品、链接号、场景、人群、产品名或承诺。',
      '3. 在满足前两条的前提下，改动越大越好，可以重组语序、替换说法、改变开场和强调顺序。',
      '4. 每条长度不得短于原句。',
      '5. 每条长度不得明显过长，避免生成超长 TTS 文案。',
      '6. 每条只输出一行，格式必须是 “序号|||改写结果”。',
      '',
      blocks.join('\n\n'),
      '',
      '现在开始输出：'
    ].join('\n')
  }

  private parseBatchResponse(content: string, items: PreparedRewriteItem[]): Array<string | null> {
    const parsed = new Map<number, string>()
    const lines = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)

    for (const line of lines) {
      const match = line.match(/^(\d+)\|\|\|(.*)$/)
      if (!match) continue
      parsed.set(Number(match[1]), match[2].trim())
    }

    return items.map((item) => this.validateRewrite(item, parsed.get(item.order) || ''))
  }

  private async rewriteSingle(
    roomId: string,
    source: ScriptSourceContext,
    item: PreparedRewriteItem,
    aiSystemPrompt: string,
    shortcutStyle: string[]
  ): Promise<string> {
    const userPrompt = [
      '请只改写这一条中文直播话术，不要解释。',
      '硬规则：',
      '1. 必须保留所有占位符，并保持出现次数不变。',
      '2. 不得改变事实、价格、数量、规格、型号、日期、赠品、链接号、场景、人群、产品名和承诺。',
      '3. 改动尽可能大。',
      '4. 长度不得短于原句。',
      `5. 长度不得超过${this.getMaxRewriteLength(item.sourceText.length)}字。`,
      `原句：${item.placeholderText}`,
      `必须保留的占位符：${item.protectedTokens.length > 0 ? item.protectedTokens.map((token) => `${token.token}=${token.value}`).join('；') : '无'}`,
      `最近版本（避免接近）：${item.recentVariants.length > 0 ? item.recentVariants.slice(-2).join(' / ') : '无'}`,
      '只输出改写结果本身。'
    ].join('\n')

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const resp = await llmService.chat(
          [
            {
              role: 'system',
              content: [
                '你是一名专业直播话术改写助手，只负责在不改变事实的前提下重写中文直播话术。',
                aiSystemPrompt.trim() ? `角色设定：${aiSystemPrompt.trim()}` : '',
                shortcutStyle.length > 0 ? `风格参考：\n${shortcutStyle.map((line, index) => `${index + 1}. ${line}`).join('\n')}` : '',
                `当前脚本来源：${source.name}`
              ].filter(Boolean).join('\n\n')
            },
            { role: 'user', content: userPrompt }
          ],
          undefined,
          {
            max_tokens: 1024,
            temperature: 0.95
          }
        )

        const validated = this.validateRewrite(item, resp.content)
        if (validated) {
          return validated
        }
      } catch (err: any) {
        console.error('[OrderedGeneralize] single rewrite failed:', err.message)
      }
    }

    return item.sourceText
  }

  private validateRewrite(item: PreparedRewriteItem, raw: string): string | null {
    const singleLine = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean)

    if (!singleLine) return null

    const normalized = singleLine.replace(/^["'“”]+|["'“”]+$/g, '').trim()
    if (!normalized) return null

    for (const token of item.protectedTokens) {
      if (this.countOccurrences(normalized, token.token) !== token.occurrences) {
        return null
      }
    }

    const restored = this.restoreProtectedTokens(normalized, item.protectedTokens)
      .replace(/\s+/g, ' ')
      .trim()

    if (!restored) return null
    if (restored.length < item.sourceText.length) return null
    if (restored.length > this.getMaxRewriteLength(item.sourceText.length)) return null
    if (this.hasUnexpectedNumericTokens(item.sourceText, restored)) return null

    const recentSimilar = item.recentVariants.some((variant) => this.textSimilarity(variant, restored) > 0.96)
    if (recentSimilar) return null

    if (restored === item.sourceText) return null
    if (item.sourceText.length >= 18 && this.textSimilarity(item.sourceText, restored) > 0.95) return null

    return restored
  }

  private protectText(text: string, source: ScriptSourceContext): ProtectedToken[] {
    const terms = new Set<string>()

    if (source.name && text.includes(source.name)) {
      terms.add(source.name)
    }

    for (const pattern of PROTECTED_PATTERNS) {
      for (const match of text.matchAll(pattern)) {
        const value = String(match[0] || '').trim()
        if (value) {
          terms.add(value)
        }
      }
    }

    for (const token of CONTEXT_TOKENS) {
      if (text.includes(token)) {
        terms.add(token)
      }
    }

    const tokens: ProtectedToken[] = []
    let working = text
    let tokenIndex = 1

    for (const value of Array.from(terms).sort((a, b) => b.length - a.length)) {
      const occurrences = this.countOccurrences(working, value)
      if (occurrences <= 0) continue

      const token = `[[P${tokenIndex}]]`
      tokenIndex += 1
      working = working.split(value).join(token)
      tokens.push({ token, value, occurrences })
    }

    return tokens
  }

  private applyProtectedTokens(text: string, tokens: ProtectedToken[]): string {
    let result = text
    for (const token of tokens) {
      result = result.split(token.value).join(token.token)
    }
    return result
  }

  private restoreProtectedTokens(text: string, tokens: ProtectedToken[]): string {
    let result = text
    for (const token of tokens) {
      result = result.split(token.token).join(token.value)
    }
    return result
  }

  private countOccurrences(text: string, needle: string): number {
    if (!needle) return 0
    return text.split(needle).length - 1
  }

  private hasUnexpectedNumericTokens(source: string, rewritten: string): boolean {
    const sourceTokens = new Set(this.extractNumericTokens(source))
    const rewrittenTokens = this.extractNumericTokens(rewritten)
    return rewrittenTokens.some((token) => !sourceTokens.has(token))
  }

  private extractNumericTokens(text: string): string[] {
    return Array.from(text.matchAll(/\d+(?:\.\d+)?/g)).map((match) => match[0])
  }

  private textSimilarity(a: string, b: string): number {
    if (a === b) return 1

    const left = this.toBigrams(a)
    const right = this.toBigrams(b)
    if (left.length === 0 || right.length === 0) return 0

    const counts = new Map<string, number>()
    for (const gram of left) {
      counts.set(gram, (counts.get(gram) || 0) + 1)
    }

    let overlap = 0
    for (const gram of right) {
      const current = counts.get(gram) || 0
      if (current > 0) {
        overlap += 1
        counts.set(gram, current - 1)
      }
    }

    return (2 * overlap) / (left.length + right.length)
  }

  private toBigrams(text: string): string[] {
    const normalized = text.replace(/\s+/g, '')
    if (normalized.length < 2) return [normalized]

    const grams: string[] = []
    for (let i = 0; i < normalized.length - 1; i++) {
      grams.push(normalized.slice(i, i + 2))
    }
    return grams
  }
}

export const orderedGeneralizeService = new OrderedGeneralizeService()
