import { BrowserWindow } from 'electron'
import type { PlatformAdapter, LiveEvent } from './adapter.interface'

/**
 * WeChat Video Channel (微信视频号) platform adapter.
 *
 * Opens 视频号管理后台 in a BrowserWindow, captures danmaku via:
 *   1. DOM MutationObserver — watches ALL new nodes (primary)
 *   2. CDP WebSocket frame interception (secondary — JSON frames)
 *   3. JS WebSocket hook + binary frame logging (tertiary)
 */
export class WeixinChannelAdapter implements PlatformAdapter {
  readonly platform = 'weixin_channel'

  private browserWindow: BrowserWindow | null = null
  private status: 'connected' | 'disconnected' | 'error' = 'disconnected'
  private eventCallback: ((event: LiveEvent) => void) | null = null
  private debuggerAttached = false
  private loginCheckInterval: ReturnType<typeof setInterval> | null = null
  private injectionInterval: ReturnType<typeof setInterval> | null = null
  private consoleListenerAttached = false

  private static readonly SESSION_PARTITION = 'persist:weixin_channel'
  private static readonly BACKEND_URL =
    'https://channels.weixin.qq.com/platform/live/liveBuild'

  // ─── Public API ───────────────────────────────────────────────────────────

  async connect(_credential: any): Promise<void> {
    if (this.browserWindow && !this.browserWindow.isDestroyed()) {
      this.browserWindow.focus()
      return
    }

    this.status = 'disconnected'
    this.consoleListenerAttached = false
    this.createBrowserWindow()
    this.setupConsoleListener()
    this.setupNavigationListeners()
    this.attachCDP()

    this.browserWindow!.loadURL(WeixinChannelAdapter.BACKEND_URL)
    this.startLoginCheck()
  }

  disconnect(): void {
    this.stopLoginCheck()
    this.stopInjectionInterval()
    this.detachCDP()

    if (this.browserWindow && !this.browserWindow.isDestroyed()) {
      this.browserWindow.close()
    }
    this.browserWindow = null
    this.status = 'disconnected'
    this.consoleListenerAttached = false
    console.log('[WeixinChannel] Disconnected')
  }

  getStatus(): 'connected' | 'disconnected' | 'error' {
    return this.status
  }

  onEvent(callback: (event: LiveEvent) => void): void {
    this.eventCallback = callback
  }

  offEvent(): void {
    this.eventCallback = null
  }

  // ─── BrowserWindow ────────────────────────────────────────────────────────

  private createBrowserWindow(): void {
    this.browserWindow = new BrowserWindow({
      width: 1100,
      height: 750,
      title: '视频号管理后台 — 云映数字人',
      show: true,
      autoHideMenuBar: true,
      webPreferences: {
        partition: WeixinChannelAdapter.SESSION_PARTITION,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false
      }
    })

    const chromeUA =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    this.browserWindow.webContents.setUserAgent(chromeUA)

    this.browserWindow.on('closed', () => {
      const wasConnected = this.status === 'connected'
      this.browserWindow = null
      this.debuggerAttached = false
      this.consoleListenerAttached = false
      this.stopLoginCheck()
      this.stopInjectionInterval()
      this.status = 'disconnected'

      if (wasConnected) {
        console.log('[WeixinChannel] Window closed')
        this.notifyRendererDisconnected()
      }
    })

    console.log('[WeixinChannel] BrowserWindow created')
  }

  private notifyRendererDisconnected(): void {
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed()) continue
      const url = w.webContents.getURL()
      if (!url.includes('player.html') && !url.includes('channels.weixin.qq.com')) {
        w.webContents.send('platform:disconnected')
        break
      }
    }
  }

  // ─── Navigation & login detection ─────────────────────────────────────────

  private setupNavigationListeners(): void {
    if (!this.browserWindow) return
    const wc = this.browserWindow.webContents

    wc.on('did-navigate', (_e, url) => {
      console.log('[WeixinChannel] Navigated:', url)
      this.onPageReady(url)
    })
    wc.on('did-navigate-in-page', (_e, url) => {
      console.log('[WeixinChannel] SPA nav:', url)
      this.onPageReady(url)
    })
    wc.on('did-finish-load', () => {
      this.onPageReady(wc.getURL())
    })
  }

  private onPageReady(url: string): void {
    const isLogin = url.includes('login.html') || url.includes('/login')
    const isBackend = url.includes('/platform/') || url.includes('/live/') || url.includes('channels.weixin.qq.com')

    if (isBackend && !isLogin) {
      if (this.status !== 'connected') {
        this.status = 'connected'
        console.log('[WeixinChannel] Status: connected')
      }
      this.startInjectionInterval()
    }
  }

  private startLoginCheck(): void {
    this.stopLoginCheck()
    this.loginCheckInterval = setInterval(() => {
      if (!this.browserWindow || this.browserWindow.isDestroyed()) {
        this.stopLoginCheck()
        return
      }
      this.onPageReady(this.browserWindow.webContents.getURL())
    }, 3000)
  }

  private stopLoginCheck(): void {
    if (this.loginCheckInterval) {
      clearInterval(this.loginCheckInterval)
      this.loginCheckInterval = null
    }
  }

  // ─── Injection management ─────────────────────────────────────────────────

  /**
   * Periodically inject scripts. Scripts are idempotent (use window flags).
   * This handles SPA page transitions that might wipe injected code.
   */
  private startInjectionInterval(): void {
    if (this.injectionInterval) return

    // Inject immediately, then every 10s
    this.doInject()
    this.injectionInterval = setInterval(() => this.doInject(), 10000)
  }

  private stopInjectionInterval(): void {
    if (this.injectionInterval) {
      clearInterval(this.injectionInterval)
      this.injectionInterval = null
    }
  }

  private async doInject(): Promise<void> {
    if (!this.browserWindow || this.browserWindow.isDestroyed()) return

    try {
      await this.browserWindow.webContents.executeJavaScript(MAIN_CAPTURE_SCRIPT)
    } catch (err: any) {
      console.error('[WeixinChannel] Injection failed:', err.message)
    }
  }

  // ─── Console-message listener (receives all injected script output) ───────

  private setupConsoleListener(): void {
    if (this.consoleListenerAttached || !this.browserWindow) return
    this.consoleListenerAttached = true

    this.browserWindow.webContents.on('console-message', (_event, _level, message) => {
      // ── DOM 捕获到的弹幕 ──
      if (message.startsWith('[WX:DANMAKU]')) {
        const payload = message.substring('[WX:DANMAKU]'.length)
        try {
          const obj = JSON.parse(payload)
          if (obj.text) {
            console.log('[WeixinChannel] Danmaku:', obj.userName, ':', obj.text)
            this.emitEvent({
              type: 'danmaku',
              userId: obj.userId || '',
              userName: obj.userName || '',
              text: obj.text,
              timestamp: Date.now()
            })
          }
        } catch { /* skip */ }
        return
      }

      // ── 诊断日志 — 转发到主进程控制台 ──
      if (message.startsWith('[WX:DIAG]') || message.startsWith('[WX:OBS]')) {
        console.log('[WeixinChannel]', message)
        return
      }

      // ── WebSocket hook (fallback for JSON frames) ──
      if (message.startsWith('[WX:WS]')) {
        if (this.debuggerAttached) return
        const payload = message.substring('[WX:WS]'.length)
        try {
          const data = JSON.parse(payload)
          this.parseAndEmit(data)
        } catch { /* not JSON */ }
        return
      }
    })
  }

  // ─── CDP (secondary) ─────────────────────────────────────────────────────

  private attachCDP(): void {
    if (!this.browserWindow || this.debuggerAttached) return
    try {
      this.browserWindow.webContents.debugger.attach('1.3')
      this.debuggerAttached = true
      this.browserWindow.webContents.debugger.sendCommand('Network.enable')

      this.browserWindow.webContents.debugger.on('message', (_event, method, params) => {
        if (method === 'Network.webSocketFrameReceived') {
          this.handleCDPFrame(params)
        }
        if (method === 'Network.webSocketCreated') {
          console.log('[WeixinChannel] WS created:', (params as any).url)
        }
      })
      console.log('[WeixinChannel] CDP attached')
    } catch (err: any) {
      console.error('[WeixinChannel] CDP attach failed:', err.message)
    }
  }

  private detachCDP(): void {
    if (!this.browserWindow || !this.debuggerAttached) return
    try { this.browserWindow.webContents.debugger.detach() } catch { /* ok */ }
    this.debuggerAttached = false
  }

  private handleCDPFrame(params: any): void {
    try {
      const payload = params?.response?.payloadData
      if (!payload || typeof payload !== 'string') return
      let data: any
      try { data = JSON.parse(payload) } catch { return } // skip binary
      console.log('[WeixinChannel] WS JSON:', JSON.stringify(data).substring(0, 500))
      this.parseAndEmit(data)
    } catch { /* skip */ }
  }

  // ─── Event helpers ────────────────────────────────────────────────────────

  private emitEvent(event: LiveEvent): void {
    if (this.eventCallback) this.eventCallback(event)
  }

  private parseAndEmit(data: any): void {
    if (!this.eventCallback) return

    if (data.type || data.msg_type || data.msgType) {
      const ev = this.parseTypedMessage(data)
      if (ev) { this.emitEvent(ev); return }
    }
    if (data.messages && Array.isArray(data.messages)) {
      for (const m of data.messages) {
        const ev = this.parseTypedMessage(m)
        if (ev) this.emitEvent(ev)
      }
      return
    }
    if (data.data) {
      const inner = typeof data.data === 'string'
        ? (() => { try { return JSON.parse(data.data) } catch { return null } })()
        : data.data
      if (inner) {
        const ev = this.parseTypedMessage(inner)
        if (ev) { this.emitEvent(ev); return }
      }
    }
    if (data.content && (data.nickname || data.userName || data.username)) {
      this.emitEvent({
        type: 'danmaku',
        userId: String(data.userId || data.user_id || data.openid || ''),
        userName: data.nickname || data.userName || data.username || '',
        text: data.content || '',
        timestamp: data.timestamp || Date.now()
      })
    }
  }

  private parseTypedMessage(msg: any): LiveEvent | null {
    const t = String(msg.type || msg.msg_type || msg.msgType || msg.cmd || '').toLowerCase()
    const uid = String(msg.userId || msg.user_id || msg.openid || msg.uid || msg.user?.userId || msg.user?.openid || '')
    const uname = msg.nickname || msg.userName || msg.user_name || msg.username || msg.user?.nickname || msg.user?.userName || ''

    if (t.includes('chat') || t.includes('comment') || t.includes('danmu') || t.includes('barrage') || t === '1' || t === 'msg') {
      const text = msg.content || msg.text || msg.comment || msg.message || ''
      return text ? { type: 'danmaku', userId: uid, userName: uname, text, timestamp: msg.timestamp || Date.now() } : null
    }
    if (t.includes('gift') || t === '6') {
      return { type: 'gift', userId: uid, userName: uname, giftName: msg.giftName || msg.gift_name || 'gift', count: msg.count || msg.giftCount || 1, timestamp: msg.timestamp || Date.now() }
    }
    if (t.includes('like') || t === '4') {
      return { type: 'like', userId: uid, userName: uname, count: msg.count || 1, timestamp: msg.timestamp || Date.now() }
    }
    if (t.includes('follow') || t.includes('subscribe') || t === '7') {
      return { type: 'follow', userId: uid, userName: uname, timestamp: msg.timestamp || Date.now() }
    }
    if (t.includes('enter') || t.includes('join') || t.includes('member') || t === '2') {
      return { type: 'enter', userId: uid, userName: uname, timestamp: msg.timestamp || Date.now() }
    }
    if (t.includes('share') || t === '8') {
      return { type: 'share', userId: uid, userName: uname, timestamp: msg.timestamp || Date.now() }
    }
    return null
  }
}

// =============================================================================
// Single injected script (runs inside the 视频号管理后台 page context)
// =============================================================================

/**
 * 统一捕获脚本：
 *
 * Phase 1: 诊断 — 输出页面结构信息（仅首次）
 * Phase 2: MutationObserver — 监听所有新增 DOM 节点（不过滤 class 名）
 * Phase 3: 定时扫描 — 简单遍历可能的弹幕容器（不用 getComputedStyle）
 * Phase 4: WebSocket hook — 拦截 WS 消息
 * Phase 5: iframe 注入 — 向所有 iframe 注入同样的脚本
 *
 * 所有内容通过 console.log 前缀通知主进程。
 */
const MAIN_CAPTURE_SCRIPT = `
(function() {
  // ═════════════════════════════════════════════════════════════
  // 全局守卫 + 初始化
  // ═════════════════════════════════════════════════════════════
  if (window.__wxCaptureV3) return;
  window.__wxCaptureV3 = true;

  var seen = {};
  var seenCount = 0;
  var emitCount = 0;

  // 已知的管理后台 UI 文本（非真实弹幕）
  var UI_USERNAMES = ['直播预告', '个人专栏', '企业微信联系人', '红包封面链接', '直播回放',
    '直播数据', '粉丝管理', '账号设置', '创作者服务', '我的视频', '留言管理', '消息通知'];
  var UI_TEXTS = ['去创建', '去添加', '去设置', '去管理', '去查看', '查看详情', '去开通',
    '立即开通', '去认证', '去完善', '去绑定', '去上传', '去发布'];

  function emit(userName, text, userId) {
    if (!text || text.length < 1) return;
    // 过滤管理后台 UI 元素
    if (UI_USERNAMES.indexOf(userName) >= 0) return;
    if (UI_TEXTS.indexOf(text) >= 0) return;
    var key = (userName || '') + '|' + text;
    if (seen[key]) return;
    seen[key] = 1;
    seenCount++;
    if (seenCount > 5000) {
      seen = {};
      seenCount = 0;
    }
    emitCount++;
    console.log('[WX:DANMAKU]' + JSON.stringify({ userName: userName || '', text: text, userId: userId || '' }));
  }

  // ═════════════════════════════════════════════════════════════
  // Phase 1: 诊断（仅首次执行，延迟 3 秒让页面加载）
  // ═════════════════════════════════════════════════════════════
  if (!window.__wxDiagDone) {
    window.__wxDiagDone = true;

    setTimeout(function() {
      try {
        var body = document.body;
        if (!body) { console.log('[WX:DIAG] no body'); return; }

        // iframe 检查
        var iframes = document.querySelectorAll('iframe');
        console.log('[WX:DIAG] iframes: ' + iframes.length);
        for (var fi = 0; fi < iframes.length; fi++) {
          console.log('[WX:DIAG] iframe[' + fi + '] src=' + (iframes[fi].src || '(empty)'));
        }

        // 总元素数
        var all = body.getElementsByTagName('*');
        console.log('[WX:DIAG] total elements: ' + all.length);

        // 找可能的弹幕容器：有 overflow 样式且有 >3 个子元素的容器
        var containers = [];
        for (var i = 0; i < all.length; i++) {
          var el = all[i];
          if (el.children.length < 3) continue;
          // 检查 style 属性（避免 getComputedStyle 的性能开销）
          var ov = el.style.overflow || el.style.overflowY || '';
          var isScroll = (ov === 'auto' || ov === 'scroll' || ov === 'hidden');
          // 也检查 scrollHeight（如果内容溢出说明可能是列表）
          if (!isScroll && el.scrollHeight <= el.clientHeight + 20) continue;
          if (el.children.length >= 3) {
            var lastChild = el.children[el.children.length - 1];
            var sample = lastChild ? lastChild.textContent.substring(0, 120) : '';
            containers.push({
              tag: el.tagName,
              cls: (el.className && typeof el.className === 'string') ? el.className.substring(0, 150) : '',
              kids: el.children.length,
              sH: el.scrollHeight,
              cH: el.clientHeight,
              sample: sample
            });
          }
        }
        console.log('[WX:DIAG] potential containers: ' + containers.length);
        for (var ci = 0; ci < Math.min(containers.length, 20); ci++) {
          var c = containers[ci];
          console.log('[WX:DIAG]   [' + ci + '] <' + c.tag + '> cls="' + c.cls + '" kids=' + c.kids + ' scroll=' + c.sH + '/' + c.cH + ' sample="' + c.sample + '"');
        }

        // 输出页面上所有含"：" 的短文本（弹幕常用格式）
        var colonTexts = [];
        for (var ti = 0; ti < all.length && colonTexts.length < 15; ti++) {
          var tel = all[ti];
          if (tel.children.length > 0) continue;
          var tt = (tel.textContent || '').trim();
          if (tt.length > 3 && tt.length < 200) {
            var hasColon = tt.indexOf('\\uff1a') > 0 || (tt.indexOf(':') > 0 && tt.indexOf(':') < 25);
            if (hasColon) {
              colonTexts.push(tt.substring(0, 100));
            }
          }
        }
        if (colonTexts.length > 0) {
          console.log('[WX:DIAG] colon-texts: ' + JSON.stringify(colonTexts));
        }

        // 输出部分 class 名（随机采样）以了解命名风格
        var sampleClasses = [];
        for (var si = 0; si < all.length && sampleClasses.length < 30; si++) {
          var sel = all[si];
          if (typeof sel.className === 'string' && sel.className.trim() && sel.textContent.trim().length > 0 && sel.textContent.trim().length < 100) {
            var cn = sel.className.trim().split(/\\s+/)[0];
            if (cn && sampleClasses.indexOf(cn) < 0) {
              sampleClasses.push(cn);
            }
          }
        }
        console.log('[WX:DIAG] sample-classes: ' + sampleClasses.join(', '));

      } catch(e) {
        console.log('[WX:DIAG] error: ' + e.message);
      }
    }, 3000);
  }

  // ═════════════════════════════════════════════════════════════
  // 公共工具：排除 UI 元素（导航、菜单、侧边栏等）
  // ═════════════════════════════════════════════════════════════

  // 只过滤已确认的假弹幕来源（视频号管理后台左侧导航菜单）
  function isUIElement(el) {
    var cls = (typeof el.className === 'string') ? el.className.toLowerCase() : '';
    // 精确匹配已知的导航菜单 class
    if (cls.indexOf('finder-ui-desktop-menu') >= 0) return true;
    // NAV 标签本身
    if (el.tagName === 'NAV') return true;
    return false;
  }

  // ═════════════════════════════════════════════════════════════
  // Phase 2: MutationObserver — 监听所有新增节点
  // ═════════════════════════════════════════════════════════════

  // 从一个 element 中提取弹幕
  function tryExtract(el) {
    if (!el || el.nodeType !== 1) return;
    var full = (el.textContent || '').trim();
    if (full.length < 2 || full.length > 500) return;

    // 策略1: 子元素中找 name 和 content（不限定 class 关键词，按位置猜）
    var kids = el.children;

    // 1a: 查找包含 name/nick/user 和 content/text/msg 的子元素（深度搜索）
    var nameEl = el.querySelector('[class*="name" i], [class*="nick" i], [class*="user" i], [class*="author" i]');
    var textEl = el.querySelector('[class*="content" i], [class*="text" i], [class*="msg" i], [class*="desc" i], [class*="comment" i]');
    if (nameEl && textEl && nameEl !== textEl) {
      var n = nameEl.textContent.trim();
      var t = textEl.textContent.trim();
      if (n && t && n !== t) {
        emit(n, t, '');
        return;
      }
    }

    // 1b: 如果有 2-6 个直接子元素，按顺序猜测
    if (kids.length >= 2 && kids.length <= 6) {
      var texts = [];
      for (var i = 0; i < kids.length; i++) {
        var ct = kids[i].textContent.trim();
        if (ct) texts.push(ct);
      }
      if (texts.length >= 2 && texts[0].length <= 30 && texts[0].length > 0) {
        emit(texts[0], texts.slice(1).join(' '), '');
        return;
      }
    }

    // 策略2: 按冒号分割
    var colonIdx = full.indexOf('\\uff1a'); // ：
    if (colonIdx < 0) {
      var ci = full.indexOf(':');
      if (ci > 0 && ci < 25) colonIdx = ci;
    }
    if (colonIdx > 0 && colonIdx < full.length - 1) {
      emit(full.substring(0, colonIdx).trim(), full.substring(colonIdx + 1).trim(), '');
      return;
    }

    // 策略3 (兜底): 如果所有策略都失败，但元素是弹幕列表中的项目
    // 尝试从父级上下文提取用户名，或用"观众"占位
    // 仅当 full 是纯文本（无子元素或只有 inline 子元素）且长度合理时
    if (full.length >= 2 && full.length <= 100) {
      // 检查是否在一个弹幕列表容器中（父元素有多个同级兄弟）
      var parent = el.parentElement;
      if (parent && parent.children.length >= 3) {
        // 尝试从元素自身找用户名（可能用不同结构嵌套）
        var allSpans = el.querySelectorAll('span, em, b, strong, a');
        if (allSpans.length >= 2) {
          var firstName = allSpans[0].textContent.trim();
          var restText = '';
          for (var si = 1; si < allSpans.length; si++) {
            var st = allSpans[si].textContent.trim();
            if (st) restText += (restText ? ' ' : '') + st;
          }
          if (firstName && restText && firstName !== restText && firstName.length <= 30) {
            emit(firstName, restText, '');
            return;
          }
        }
        // 最后兜底: 用"观众"作为用户名，全文作为弹幕内容
        // 只在文本看起来像弹幕（不含 UI 按钮文本特征）时执行
        if (full.indexOf('去') !== 0 && full.indexOf('立即') !== 0 && full.indexOf('查看') !== 0) {
          emit('观众', full, '');
        }
      }
    }
  }

  // 检查一个新增节点是否可能是弹幕项
  function processNewNode(node) {
    if (node.nodeType !== 1) return;

    var text = (node.textContent || '').trim();
    if (text.length < 2 || text.length > 500) return;

    // 排除 UI 元素
    if (isUIElement(node)) return;

    // 有子元素 → 可能是一条弹幕的容器
    if (node.children.length >= 1 && node.children.length <= 10) {
      tryExtract(node);
      return;
    }

    // 没有子元素但有文本 → 可能是弹幕文本本身
    // 检查父元素（及祖父元素）是否像弹幕项
    if (node.children.length === 0 && node.parentElement) {
      var parent = node.parentElement;
      if (isUIElement(parent)) return;
      if (parent.children.length >= 2 && parent.children.length <= 10) {
        tryExtract(parent);
      } else if (parent.parentElement && !isUIElement(parent.parentElement)) {
        // 多一层向上查找（弹幕可能嵌套更深）
        var grandparent = parent.parentElement;
        if (grandparent.children.length >= 2 && grandparent.children.length <= 10) {
          tryExtract(grandparent);
        }
      }
    }
  }

  var observer = new MutationObserver(function(mutations) {
    for (var m = 0; m < mutations.length; m++) {
      var added = mutations[m].addedNodes;
      for (var n = 0; n < added.length; n++) {
        processNewNode(added[n]);
      }
    }
  });

  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
    console.log('[WX:OBS] MutationObserver started');
  } else {
    document.addEventListener('DOMContentLoaded', function() {
      observer.observe(document.body, { childList: true, subtree: true });
      console.log('[WX:OBS] MutationObserver started (after DOMContentLoaded)');
    });
  }

  // ═════════════════════════════════════════════════════════════
  // Phase 3: 定时扫描（轻量级，不用 getComputedStyle）
  // ═════════════════════════════════════════════════════════════

  var scanCount = 0;

  function scanContainers() {
    scanCount++;
    var body = document.body;
    if (!body) return;

    var all = body.getElementsByTagName('*');
    var found = 0;

    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var kidCount = el.children.length;
      if (kidCount < 5) continue;
      // 只检查内容是否溢出（不调用 getComputedStyle）
      if (el.scrollHeight <= el.clientHeight + 10) continue;
      // 排除 UI 元素（导航菜单、侧边栏等）
      if (isUIElement(el)) continue;

      found++;
      // 扫描最后 5 个子元素
      for (var j = Math.max(0, kidCount - 5); j < kidCount; j++) {
        tryExtract(el.children[j]);
      }
    }

    // 每 30 次扫描（约 60 秒）报告一次状态
    if (scanCount % 30 === 1) {
      console.log('[WX:OBS] scan #' + scanCount + ' containers=' + found + ' emitted=' + emitCount);
    }
  }

  setInterval(scanContainers, 2000);

  // ═════════════════════════════════════════════════════════════
  // Phase 4: WebSocket hook
  // ═════════════════════════════════════════════════════════════

  if (!window.__wxWSHooked) {
    window.__wxWSHooked = true;
    var OrigWS = window.WebSocket;

    window.WebSocket = function(url, protocols) {
      console.log('[WX:OBS] New WebSocket: ' + url);
      var ws = protocols ? new OrigWS(url, protocols) : new OrigWS(url);

      // Hook addEventListener('message')
      var origAdd = ws.addEventListener.bind(ws);
      ws.addEventListener = function(type, listener, opts) {
        if (type === 'message') {
          var wrapped = function(event) {
            try {
              if (typeof event.data === 'string' && event.data.length < 5000) {
                console.log('[WX:WS]' + event.data.substring(0, 2000));
              } else if (event.data instanceof ArrayBuffer) {
                console.log('[WX:OBS] WS binary len=' + event.data.byteLength);
              } else if (event.data instanceof Blob) {
                console.log('[WX:OBS] WS Blob size=' + event.data.size);
              }
            } catch(e) {}
            return listener.call(this, event);
          };
          return origAdd(type, wrapped, opts);
        }
        return origAdd(type, listener, opts);
      };

      // Hook onmessage property
      var _onmsg = null;
      Object.defineProperty(ws, 'onmessage', {
        get: function() { return _onmsg; },
        set: function(handler) {
          _onmsg = function(event) {
            try {
              if (typeof event.data === 'string' && event.data.length < 5000) {
                console.log('[WX:WS]' + event.data.substring(0, 2000));
              }
            } catch(e) {}
            return handler.call(this, event);
          };
        }
      });

      return ws;
    };
    window.WebSocket.prototype = OrigWS.prototype;
    window.WebSocket.CONNECTING = OrigWS.CONNECTING;
    window.WebSocket.OPEN = OrigWS.OPEN;
    window.WebSocket.CLOSING = OrigWS.CLOSING;
    window.WebSocket.CLOSED = OrigWS.CLOSED;

    console.log('[WX:OBS] WebSocket hook installed');
  }

  // ═════════════════════════════════════════════════════════════
  // Phase 5: iframe 注入
  // ═════════════════════════════════════════════════════════════

  function injectIntoIframes() {
    var iframes = document.querySelectorAll('iframe');
    for (var i = 0; i < iframes.length; i++) {
      try {
        var doc = iframes[i].contentDocument || (iframes[i].contentWindow && iframes[i].contentWindow.document);
        if (!doc || !doc.body) continue;
        if (iframes[i].contentWindow.__wxCaptureV3) continue;

        // 在 iframe 中设置相同的 MutationObserver
        iframes[i].contentWindow.__wxCaptureV3 = true;
        var iframeBody = doc.body;
        var iframeObserver = new MutationObserver(function(mutations) {
          for (var m = 0; m < mutations.length; m++) {
            var added = mutations[m].addedNodes;
            for (var n = 0; n < added.length; n++) {
              processNewNode(added[n]);
            }
          }
        });
        iframeObserver.observe(iframeBody, { childList: true, subtree: true });
        console.log('[WX:OBS] Injected into iframe[' + i + ']');
      } catch(e) {
        // Cross-origin iframe — can't access
        console.log('[WX:OBS] iframe[' + i + '] cross-origin, skipped');
      }
    }
  }

  // 延迟注入到 iframe（等待 iframe 加载）
  setTimeout(injectIntoIframes, 5000);
  setTimeout(injectIntoIframes, 15000);

  console.log('[WX:OBS] Capture script v3 initialized');
})();
`
