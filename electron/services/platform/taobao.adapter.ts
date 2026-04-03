import { BrowserWindow } from 'electron'
import type { PlatformAdapter, LiveEvent } from './adapter.interface'

/**
 * Taobao Live (淘宝直播) platform adapter.
 *
 * Opens 淘宝直播 page in a BrowserWindow, captures danmaku via:
 *   1. CDP Network interception — intercepts HTTP responses for `mtop.taobao.iliad.comment.query.latest`
 *   2. DOM MutationObserver — watches for new comment nodes (fallback)
 *   3. Periodic polling — triggers the comment API via page scroll/interaction
 *
 * Reference: yundingyunbo taobao_danmu.py uses Playwright to intercept the same API.
 * We use Electron BrowserWindow + CDP instead of Playwright for consistency with other adapters.
 */
export class TaobaoAdapter implements PlatformAdapter {
  readonly platform = 'taobao'

  private browserWindow: BrowserWindow | null = null
  private status: 'connected' | 'disconnected' | 'error' = 'disconnected'
  private eventCallback: ((event: LiveEvent) => void) | null = null
  private debuggerAttached = false
  private loginCheckInterval: ReturnType<typeof setInterval> | null = null
  private injectionInterval: ReturnType<typeof setInterval> | null = null
  private consoleListenerAttached = false

  /** Track seen comments to avoid duplicates (publisherNick + content) */
  private seenComments = new Set<string>()

  private static readonly SESSION_PARTITION = 'persist:taobao_live'

  // ─── Public API ───────────────────────────────────────────────────────────

  async connect(credential: any): Promise<void> {
    if (this.browserWindow && !this.browserWindow.isDestroyed()) {
      this.browserWindow.focus()
      return
    }

    const liveUrl = credential?.url || credential?.roomUrl || ''

    this.status = 'disconnected'
    this.consoleListenerAttached = false
    this.seenComments.clear()
    this.createBrowserWindow()
    this.setupConsoleListener()
    this.setupNavigationListeners()
    this.attachCDP()

    // If a specific live room URL is provided, open it directly.
    // Otherwise open the Taobao live home page for the user to navigate.
    const url = liveUrl || 'https://live.taobao.com'
    this.browserWindow!.loadURL(url)
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
    this.seenComments.clear()
    console.log('[Taobao] Disconnected')
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
      title: '淘宝直播 — 弹幕捕获',
      show: true,
      autoHideMenuBar: true,
      webPreferences: {
        partition: TaobaoAdapter.SESSION_PARTITION,
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
        console.log('[Taobao] Window closed')
        this.notifyRendererDisconnected()
      }
    })

    console.log('[Taobao] BrowserWindow created')
  }

  private notifyRendererDisconnected(): void {
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed()) continue
      const url = w.webContents.getURL()
      if (!url.includes('player.html') && !url.includes('taobao.com')) {
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
      console.log('[Taobao] Navigated:', url)
      this.onPageReady(url)
    })
    wc.on('did-navigate-in-page', (_e, url) => {
      console.log('[Taobao] SPA nav:', url)
      this.onPageReady(url)
    })
    wc.on('did-finish-load', () => {
      this.onPageReady(wc.getURL())
    })
  }

  private onPageReady(url: string): void {
    const isLogin = url.includes('login.taobao.com') || url.includes('login.tmall.com')
    const isLive = url.includes('live.taobao.com') || url.includes('tblive') || url.includes('taobao.com/live')

    if (isLive && !isLogin) {
      if (this.status !== 'connected') {
        this.status = 'connected'
        console.log('[Taobao] Status: connected')
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

  private startInjectionInterval(): void {
    if (this.injectionInterval) return
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
      await this.browserWindow.webContents.executeJavaScript(TAOBAO_CAPTURE_SCRIPT)
    } catch (err: any) {
      console.error('[Taobao] Injection failed:', err.message)
    }
  }

  // ─── Console-message listener ────────────────────────────────────────────

  private setupConsoleListener(): void {
    if (this.consoleListenerAttached || !this.browserWindow) return
    this.consoleListenerAttached = true

    this.browserWindow.webContents.on('console-message', (_event, _level, message) => {
      // DOM-captured danmaku
      if (message.startsWith('[TB:DANMAKU]')) {
        const payload = message.substring('[TB:DANMAKU]'.length)
        try {
          const obj = JSON.parse(payload)
          if (obj.text) {
            this.emitDanmaku(obj.userName || '观众', obj.text, obj.userId || '')
          }
        } catch { /* skip */ }
        return
      }

      // Diagnostic logs
      if (message.startsWith('[TB:DIAG]') || message.startsWith('[TB:OBS]')) {
        console.log('[Taobao]', message)
        return
      }
    })
  }

  // ─── CDP (primary: HTTP response interception) ────────────────────────────

  private attachCDP(): void {
    if (!this.browserWindow || this.debuggerAttached) return
    try {
      this.browserWindow.webContents.debugger.attach('1.3')
      this.debuggerAttached = true
      this.browserWindow.webContents.debugger.sendCommand('Network.enable')

      this.browserWindow.webContents.debugger.on('message', (_event, method, params) => {
        if (method === 'Network.responseReceived') {
          this.handleNetworkResponse(params)
        }
      })
      console.log('[Taobao] CDP attached')
    } catch (err: any) {
      console.error('[Taobao] CDP attach failed:', err.message)
    }
  }

  private detachCDP(): void {
    if (!this.browserWindow || !this.debuggerAttached) return
    try { this.browserWindow.webContents.debugger.detach() } catch { /* ok */ }
    this.debuggerAttached = false
  }

  /**
   * Intercept HTTP responses matching the Taobao comment API.
   * The API returns JSONP: `mtopjsonp123({...})` — we strip the wrapper and parse.
   */
  private async handleNetworkResponse(params: any): Promise<void> {
    try {
      const url: string = params?.response?.url || ''

      // Match the comment query API
      if (!url.includes('mtop.taobao.iliad.comment.query.latest') &&
          !url.includes('mtop.taobao.iliad.comment') &&
          !url.includes('comment.query')) {
        return
      }

      const requestId = params?.requestId
      if (!requestId) return

      console.log('[Taobao] Intercepted comment API:', url.substring(0, 200))

      // Get response body via CDP
      let body: string
      try {
        const result = await this.browserWindow!.webContents.debugger.sendCommand(
          'Network.getResponseBody',
          { requestId }
        )
        body = result.body
      } catch {
        return // body not available (e.g. still loading)
      }

      if (!body) return

      // Strip JSONP wrapper: mtopjsonpN(...) → inner JSON
      let jsonStr = body
      const jsonpMatch = body.match(/^mtopjsonp\d*\((.+)\)$/s)
      if (jsonpMatch) {
        jsonStr = jsonpMatch[1]
      }

      let data: any
      try {
        data = JSON.parse(jsonStr)
      } catch {
        console.warn('[Taobao] Failed to parse comment API response')
        return
      }

      // Extract comments from the response
      // Structure: data.data.comments[] or data.data.result.comments[]
      const comments = data?.data?.comments
        || data?.data?.result?.comments
        || data?.data?.data?.comments
        || []

      if (!Array.isArray(comments)) return

      for (const comment of comments) {
        const nick = comment.publisherNick || comment.nickname || comment.userName || ''
        const content = comment.content || comment.text || ''
        if (!nick || !content) continue
        this.emitDanmaku(nick, content, comment.publisherId || comment.userId || '')
      }

      if (comments.length > 0) {
        console.log(`[Taobao] Parsed ${comments.length} comments from API`)
      }
    } catch (err: any) {
      console.error('[Taobao] handleNetworkResponse error:', err.message)
    }
  }

  // ─── Event helpers ────────────────────────────────────────────────────────

  private emitDanmaku(userName: string, text: string, userId: string): void {
    if (!text.trim()) return

    // Dedup
    const key = `${userName}|${text}`
    if (this.seenComments.has(key)) return
    this.seenComments.add(key)
    if (this.seenComments.size > 5000) this.seenComments.clear()

    this.emitEvent({
      type: 'danmaku',
      userId,
      userName,
      text,
      timestamp: Date.now()
    })
  }

  private emitEvent(event: LiveEvent): void {
    if (this.eventCallback) this.eventCallback(event)
  }
}

// =============================================================================
// Injected script (runs inside the Taobao live page context)
// =============================================================================

/**
 * DOM-based danmaku capture for Taobao Live.
 *
 * Taobao live pages display comments in a scrollable list.
 * This script uses MutationObserver to capture new comment nodes.
 * It serves as a fallback — the primary capture is via CDP HTTP interception.
 */
const TAOBAO_CAPTURE_SCRIPT = `
(function() {
  if (window.__tbCaptureV1) return;
  window.__tbCaptureV1 = true;

  var seen = {};
  var seenCount = 0;
  var emitCount = 0;

  function emit(userName, text, userId) {
    if (!text || text.length < 1) return;
    var key = (userName || '') + '|' + text;
    if (seen[key]) return;
    seen[key] = 1;
    seenCount++;
    if (seenCount > 5000) {
      seen = {};
      seenCount = 0;
    }
    emitCount++;
    console.log('[TB:DANMAKU]' + JSON.stringify({ userName: userName || '', text: text, userId: userId || '' }));
  }

  // ── Phase 1: Diagnostic (once) ──
  if (!window.__tbDiagDone) {
    window.__tbDiagDone = true;
    setTimeout(function() {
      try {
        var iframes = document.querySelectorAll('iframe');
        console.log('[TB:DIAG] iframes: ' + iframes.length);
        var all = document.body.getElementsByTagName('*');
        console.log('[TB:DIAG] total elements: ' + all.length);
      } catch(e) {
        console.log('[TB:DIAG] error: ' + e.message);
      }
    }, 3000);
  }

  // ── Phase 2: MutationObserver — watch for new comment nodes ──
  function tryExtract(el) {
    if (!el || el.nodeType !== 1) return;
    var full = (el.textContent || '').trim();
    if (full.length < 2 || full.length > 500) return;

    // Strategy 1: class-based name/content extraction
    var nameEl = el.querySelector('[class*="name" i], [class*="nick" i], [class*="user" i], [class*="author" i]');
    var textEl = el.querySelector('[class*="content" i], [class*="text" i], [class*="msg" i], [class*="comment" i], [class*="desc" i]');
    if (nameEl && textEl && nameEl !== textEl) {
      var n = nameEl.textContent.trim();
      var t = textEl.textContent.trim();
      if (n && t && n !== t) {
        emit(n, t, '');
        return;
      }
    }

    // Strategy 2: child elements as name + content
    var kids = el.children;
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

    // Strategy 3: colon-separated (nickname：content)
    var colonIdx = full.indexOf('\\uff1a');
    if (colonIdx < 0) {
      var ci = full.indexOf(':');
      if (ci > 0 && ci < 25) colonIdx = ci;
    }
    if (colonIdx > 0 && colonIdx < full.length - 1) {
      emit(full.substring(0, colonIdx).trim(), full.substring(colonIdx + 1).trim(), '');
    }
  }

  function processNewNode(node) {
    if (node.nodeType !== 1) return;
    var text = (node.textContent || '').trim();
    if (text.length < 2 || text.length > 500) return;

    if (node.children.length >= 1 && node.children.length <= 10) {
      tryExtract(node);
      return;
    }

    if (node.children.length === 0 && node.parentElement) {
      var parent = node.parentElement;
      if (parent.children.length >= 2 && parent.children.length <= 10) {
        tryExtract(parent);
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
    console.log('[TB:OBS] MutationObserver started');
  }

  // ── Phase 3: Periodic scan of last items in scrollable containers ──
  var scanCount = 0;
  function scanContainers() {
    scanCount++;
    var body = document.body;
    if (!body) return;
    var all = body.getElementsByTagName('*');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.children.length < 5) continue;
      if (el.scrollHeight <= el.clientHeight + 10) continue;
      for (var j = Math.max(0, el.children.length - 5); j < el.children.length; j++) {
        tryExtract(el.children[j]);
      }
    }
    if (scanCount % 30 === 1) {
      console.log('[TB:OBS] scan #' + scanCount + ' emitted=' + emitCount);
    }
  }
  setInterval(scanContainers, 3000);

  console.log('[TB:OBS] Capture script v1 initialized');
})();
`
