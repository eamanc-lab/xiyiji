import { llmService, type ChatMessage } from './llm.service'
import type { BatchContext } from './room-session.service'
import type { RoomTemperature } from './room-temperature'

// Language-specific configuration for multi-language output
const LANGUAGE_CONFIG: Record<string, {
  name: string           // Chinese name (used in system prompt explanations)
  nativeName: string     // Self-reference in target language
  generateInstruction: string  // Core generation instruction
}> = {
  'zh-CN': {
    name: '中文',
    nativeName: '中文',
    generateInstruction: '请根据以上所有信息，生成{count}条连贯的直播话术。'
  },
  'en': {
    name: '英语',
    nativeName: 'English',
    generateInstruction: 'Based on all the information above, generate {count} coherent live-stream scripts IN ENGLISH.'
  },
  'es': {
    name: '西班牙语',
    nativeName: 'Español',
    generateInstruction: 'Basándote en toda la información anterior, genera {count} guiones coherentes de transmisión en vivo EN ESPAÑOL.'
  }
}

/**
 * Wraps llmService with structured prompt construction for batch script generation.
 *
 * Key design:
 * - Full-context prompts: sends ALL script data (general, link, shortcuts) without truncation
 * - Batch generation: produces 10-15 lines of broadcast scripts per call
 * - Structured rhythm: instructs LLM to cover opening → product → interaction → closing
 * - Multi-language: when outputLanguage is non-Chinese, instructs LLM to generate in target language
 */
class QwenService {
  /**
   * Generate a batch of broadcast scripts using full context from all 4 sub-tabs.
   * Returns an array of script lines (empty array on failure).
   */
  async generateBatch(ctx: BatchContext): Promise<string[]> {
    try {
      const messages = this.buildBatchMessages(ctx)
      const resp = await llmService.chat(messages, undefined, {
        max_tokens: ctx.isDanmakuResponse ? 1024 : 4096,
        temperature: 0.85
      })
      const lines = this.parseBatchResponse(resp.content, ctx.forbiddenWords, ctx.outputLanguage, ctx.temperature)
      console.log(`[Qwen] generateBatch() returned ${lines.length} lines (model: ${resp.model}, lang: ${ctx.outputLanguage})`)
      return lines
    } catch (err: any) {
      console.error('[Qwen] generateBatch() failed:', err.message)
      return []
    }
  }

  private buildBatchMessages(ctx: BatchContext): ChatMessage[] {
    // Danmaku-triggered: use a completely different, focused prompt
    if (ctx.isDanmakuResponse) {
      return this.buildDanmakuResponseMessages(ctx)
    }

    const systemParts: string[] = []
    const lang = ctx.outputLanguage || 'zh-CN'
    const langConfig = LANGUAGE_CONFIG[lang] || LANGUAGE_CONFIG['zh-CN']
    const isNonChinese = lang !== 'zh-CN'

    // 0. Language instruction (only for non-Chinese output)
    if (isNonChinese) {
      systemParts.push(
        `【语言要求】\n` +
        `你是一名${langConfig.name}直播主播。以下参考资料是中文的，但你必须用${langConfig.name}（${langConfig.nativeName}）生成所有话术。` +
        `不要输出任何中文内容。`
      )
    }

    // 1. Role definition from AI system prompt (Tab4)
    if (ctx.aiSystemPrompt.trim()) {
      systemParts.push(`【角色设定】\n${ctx.aiSystemPrompt.trim()}`)
    }

    // 2. General script — full content, no truncation (Tab1)
    if (ctx.generalScript.trim()) {
      systemParts.push(
        isNonChinese
          ? `【通用直播脚本（中文参考，请转化为${langConfig.name}输出）】\n${ctx.generalScript.trim()}`
          : `【通用直播脚本】\n${ctx.generalScript.trim()}`
      )
    }

    // 3. All product links overview (Tab2)
    if (ctx.allLinks.length > 0) {
      const linkList = ctx.allLinks
        .map(l => `${l.slotNo}号链接「${l.name}」`)
        .join('、')
      systemParts.push(`【所有产品链接】\n${linkList}`)
    }

    // 4. Active product link script — full content, no truncation (Tab2)
    if (ctx.activeLink) {
      systemParts.push(
        `【当前推广产品: ${ctx.activeLink.name}（${ctx.activeLink.slotNo}号链接）】\n` +
        ctx.activeLink.content
      )
    }

    // 5. Shortcut scripts as style/expression reference (Tab3)
    if (ctx.shortcuts.length > 0) {
      systemParts.push(
        `【快捷话术参考（你的常用表达风格）】\n` +
        ctx.shortcuts.map((s, i) => `${i + 1}. ${s}`).join('\n')
      )
    }

    // 6. Forbidden words — absolute prohibition (Tab4)
    if (ctx.forbiddenWords.length > 0) {
      systemParts.push(
        `【禁用词 — 以下词语绝对不能出现在话术中】\n${ctx.forbiddenWords.join('、')}`
      )
    }

    // 7. Real-time state
    const stateParts: string[] = []
    if (ctx.playingText) {
      stateParts.push(`正在播放: ${ctx.playingText}`)
    }
    if (ctx.recentResponses.length > 0) {
      stateParts.push(`最近已播出的话术:\n${ctx.recentResponses.map(r => `- ${r}`).join('\n')}`)
    }
    if (ctx.recentDanmaku.length > 0) {
      stateParts.push(`最新弹幕:\n${ctx.recentDanmaku.map(d => `• ${d}`).join('\n')}`)
    }
    if (stateParts.length > 0) {
      systemParts.push(`【实时状态】\n${stateParts.join('\n')}`)
    }

    // 7.5 Room atmosphere + gifts + priority danmaku
    if (ctx.temperatureHint) {
      systemParts.push(`【直播间氛围】\n${ctx.temperatureHint}`)
    }
    if (ctx.giftSummary) {
      systemParts.push(`【礼物汇总】\n${ctx.giftSummary}`)
    }
    if (ctx.priorityDanmaku && ctx.priorityDanmaku.length > 0) {
      systemParts.push(
        `【★ 需要优先回应的弹幕】\n` +
        ctx.priorityDanmaku.join('\n') +
        `\n请在前1-2条话术中自然地回应以上★弹幕。`
      )
    }

    // 8. Generation instructions — language-aware
    if (isNonChinese) {
      systemParts.push(
        `【生成指令】\n` +
        `${langConfig.generateInstruction.replace('{count}', String(ctx.batchSize))}\n` +
        `要求：\n` +
        `1. 每条话术独占一行，只输出话术内容本身\n` +
        `2. 不要加序号、编号、标签、括号说明或任何前缀\n` +
        `3. 所有输出必须是${langConfig.name}（${langConfig.nativeName}），不要输出中文\n` +
        `4. 话术之间要有节奏变化，覆盖：暖场互动 → 产品介绍 → 卖点讲解 → 互动引导 → 促单逼单 → 过渡衔接\n` +
        `5. 每条话术适中长度，口语化、自然、有感染力\n` +
        `6. 如果有当前推广产品，重点围绕该产品展开讲解和促单\n` +
        `7. 如果没有指定推广产品，围绕通用脚本的内容做开场和暖场\n` +
        `8. 如果有弹幕互动，在合适的位置穿插回应（弹幕可能是中文或${langConfig.name}，都要用${langConfig.name}回复）\n` +
        `9. 不要重复"最近已播出的话术"中的内容\n` +
        `10. 参考"快捷话术"的表达风格和语气，但用${langConfig.name}表达\n` +
        `11. 严格遵守禁用词列表`
      )
    } else {
      const lengthHint = this.getChineseLengthHint(ctx.temperature)
      systemParts.push(
        `【生成指令】\n` +
        `请根据以上所有信息，生成${ctx.batchSize}条连贯的直播话术。\n` +
        `要求：\n` +
        `1. 每条话术独占一行，只输出话术内容本身\n` +
        `2. 不要加序号、编号、标签、括号说明或任何前缀\n` +
        `3. 话术之间要有节奏变化，覆盖以下类型：暖场互动 → 产品介绍 → 卖点讲解 → 互动引导 → 促单逼单 → 过渡衔接\n` +
        `4. ${lengthHint}\n` +
        `5. 如果有当前推广产品，重点围绕该产品展开讲解和促单\n` +
        `6. 如果没有指定推广产品，围绕通用脚本的内容做开场和暖场\n` +
        `7. 如果有弹幕互动，在合适的位置穿插回应弹幕的话术\n` +
        `8. 不要重复"最近已播出的话术"中的内容\n` +
        `9. 参考"快捷话术"的表达风格和语气，但不要原样照搬\n` +
        `10. 严格遵守禁用词列表，一个都不能出现`
      )
    }

    const system = systemParts.join('\n\n')

    const userMessage = isNonChinese
      ? `Generate ${ctx.batchSize} live-stream scripts, one per line (in ${langConfig.nativeName}):`
      : `请生成${ctx.batchSize}条直播话术，每条一行：`

    return [
      { role: 'system', content: system },
      { role: 'user', content: userMessage }
    ]
  }

  /**
   * Build a focused prompt for DIRECT danmaku response.
   * Unlike the full product-script prompt, this puts the viewer's message front
   * and center and instructs the LLM to respond conversationally.
   */
  private buildDanmakuResponseMessages(ctx: BatchContext): ChatMessage[] {
    const parts: string[] = []
    const lang = ctx.outputLanguage || 'zh-CN'
    const langConfig = LANGUAGE_CONFIG[lang] || LANGUAGE_CONFIG['zh-CN']
    const isNonChinese = lang !== 'zh-CN'

    // Language instruction (non-Chinese only)
    if (isNonChinese) {
      parts.push(
        `【语言要求】\n` +
        `你是一名${langConfig.name}直播主播。用${langConfig.name}（${langConfig.nativeName}）回应观众。不要输出中文。`
      )
    }

    // Role definition (keep)
    if (ctx.aiSystemPrompt.trim()) {
      parts.push(`【角色设定】\n${ctx.aiSystemPrompt.trim()}`)
    }

    // Danmaku content (THE CORE — not buried in "实时状态")
    const danmakuLines = ctx.priorityDanmaku.length > 0
      ? ctx.priorityDanmaku
      : ctx.recentDanmaku
    if (danmakuLines.length > 0) {
      parts.push(
        `【直播间互动 — 需要立即回应】\n` +
        `以下观众发了弹幕，请直接回应：\n` +
        danmakuLines.map(d => `• ${d}`).join('\n')
      )
    }

    // Product name only (brief context, NOT full script)
    if (ctx.activeLink) {
      parts.push(`【当前推广产品】${ctx.activeLink.name}（${ctx.activeLink.slotNo}号链接）`)
    }

    // Forbidden words
    if (ctx.forbiddenWords.length > 0) {
      parts.push(`【禁用词】${ctx.forbiddenWords.join('、')}`)
    }

    // Danmaku-specific generation instructions
    if (isNonChinese) {
      parts.push(
        `【生成指令】\n` +
        `Generate ${ctx.batchSize} lines IN ${langConfig.nativeName}:\n` +
        `1. First line: directly greet/respond to the viewer by name\n` +
        `2. Following lines: naturally transition back to the product topic\n` +
        `Requirements:\n` +
        `- MUST mention the viewer's nickname\n` +
        `- Conversational, warm, like a real streamer chatting with viewers\n` +
        `- If the viewer asked a question (price, how to buy, usage), give a clear answer\n` +
        `- 10-60 words per line\n` +
        `- One line per script, no numbering or prefixes`
      )
    } else {
      parts.push(
        `【生成指令】\n` +
        `生成${ctx.batchSize}条话术：\n` +
        `1. 第一条必须直接点名回应观众弹幕（如"欢迎XX！你好呀~"或"XX问怎么下单，来来来..."）\n` +
        `2. 后续自然过渡回产品话题\n` +
        `要求：\n` +
        `- 必须提到观众的昵称\n` +
        `- 口语化、热情、像真人主播在和观众聊天\n` +
        `- 如果观众问了具体问题（价格、下单、用法等），要给出明确回答\n` +
        `- 每条15-80字\n` +
        `- 每条话术独占一行，不要加序号、编号或前缀`
      )
    }

    const system = parts.join('\n\n')
    const userMessage = isNonChinese
      ? `Respond to the viewer's messages. Generate ${ctx.batchSize} lines:`
      : `请直接回应观众弹幕，生成${ctx.batchSize}条话术：`

    return [
      { role: 'system', content: system },
      { role: 'user', content: userMessage }
    ]
  }

  private getChineseLengthHint(temperature: RoomTemperature): string {
    switch (temperature) {
      case 'cold':
        return '每条话术80~250字，口语化、自然、有感染力，内容详细深入，可以讲产品故事和细节'
      case 'warm':
        return '每条话术50~150字，口语化、自然、有感染力，保持自然对话节奏'
      case 'hot':
        return '每条话术30~100字，口语化、自然、更有感染力，语言精练有力'
      case 'fire':
        return '每条话术20~80字，简短有力，高能状态，多用互动语气'
      default:
        return '每条话术15~120字，口语化、自然、有感染力，像真人主播在说话'
    }
  }

  /**
   * Parse LLM batch response into clean script lines.
   * Strips numbering, filters too-short/too-long lines, and removes forbidden words.
   * Length thresholds adjust for non-Chinese languages and room temperature.
   */
  private parseBatchResponse(
    raw: string,
    forbiddenWords: string[],
    outputLanguage: string = 'zh-CN',
    temperature?: RoomTemperature
  ): string[] {
    const isNonChinese = outputLanguage !== 'zh-CN'
    const { minLen, maxLen } = isNonChinese
      ? { minLen: 5, maxLen: 500 }
      : this.getChineseLengthLimits(temperature)

    const metaPrefixes = [
      '\u6ce8\uff1a',
      '\u6ce8\u610f\uff1a',
      '\u4ee5\u4e0a',
      '\u8bf4\u660e\uff1a',
      '\u8f93\u51fa\uff1a'
    ]
    const numberingPattern = /^\s*(?:\d+\s*[\.\)\]:\u3001]|[-*])\s*/

    const lines = raw
      .split(/\r?\n/)
      .map((line) => line.replace(numberingPattern, '').trim())
      .filter((line) => {
        if (!line) return false
        if (line.length < minLen || line.length > maxLen) return false
        if (metaPrefixes.some((prefix) => line.startsWith(prefix))) return false
        if (line.startsWith('---')) return false
        if (isNonChinese && /[\u4e00-\u9fff]/.test(line) && !/[A-Za-z]/.test(line)) return false
        return true
      })

    if (forbiddenWords.length === 0) return lines

    const lowerForbiddenWords = forbiddenWords.map((word) => word.toLowerCase()).filter(Boolean)
    return lines.filter((line) => {
      const lowerLine = line.toLowerCase()
      return !lowerForbiddenWords.some((word) => lowerLine.includes(word))
    })
  }

  private getChineseLengthLimits(temperature?: RoomTemperature): { minLen: number; maxLen: number } {
    switch (temperature) {
      case 'cold':  return { minLen: 15, maxLen: 300 }
      case 'warm':  return { minLen: 10, maxLen: 200 }
      case 'hot':   return { minLen: 8, maxLen: 150 }
      case 'fire':  return { minLen: 5, maxLen: 100 }
      default:      return { minLen: 8, maxLen: 200 }
    }
  }
}

export const qwenService = new QwenService()
