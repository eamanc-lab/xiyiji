import { BrowserWindow } from 'electron'
import type { PlatformAdapter, LiveEvent } from './adapter.interface'

/**
 * Xiaohongshu Live (小红书直播) platform adapter.
 *
 * Opens 小红书创作者中心直播 page in a BrowserWindow, captures danmaku via:
 *   1. DOM MutationObserver — watches for new comment nodes (primary)
 *   2. CDP WebSocket frame interception (secondary — captures real-time WS messages)
 *   3. Periodic DOM scanning (fallback)
 *
 * Xiaohongshu live comments are displayed in the browser-based creator dashboard.
 * Unlike Taobao (which has a clear HTTP API), Xiaohongshu uses WebSocket for real-time
 * comment delivery, plus DOM rendering. We capture from both channels.
 */
export class XiaohongshuAdapter implements PlatformAdapter {
  readonly platform = 'xiaohongshu'

  private browserWindow: BrowserWindow | null = null
  private status: 'connected' | 'disconnected' | 'error' = 'disconnected'
  private eventCallback: ((event: LiveEvent) => void) | null = null
  private debuggerAttached = false
  private loginCheckInterval: ReturnType<typeof setInterval> | null = null
  private injectionInterval: ReturnType<typeof setInterval> | null = null
  private consoleListenerAttached = false

  private static readonly SESSION_PARTITION = 'persist:xiaohongshu_live'
  // 小红书创作者服务平台 - 直播中控台
  private static readonly CREATOR_URL = 'https://www.xiaohongshu.com/livestream/control'
  // 备选: 直播入口页
  private static readonly LIVE_URL = 'https://www.xiaohongshu.com/livestream'

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

    this.browserWindow!.loadURL(XiaohongshuAdapter.LIVE_URL)
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
    console.log('[Xiaohongshu] Disconnected')
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
      width: 1200,
      height: 800,
      title: '小红书直播 — 弹幕捕获',
      show: true,
      autoHideMenuBar: true,
      webPreferences: {
        partition: XiaohongshuAdapter.SESSION_PARTITION,
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
        console.log('[Xiaohongshu] Window closed')
        this.notifyRendererDisconnected()
      }
    })

    console.log('[Xiaohongshu] BrowserWindow created')
  }

  private notifyRendererDisconnected(): void {
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed()) continue
      const url = w.webContents.getURL()
      if (!url.includes('player.html') && !url.includes('xiaohongshu.com')) {
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
      console.log('[Xiaohongshu] Navigated:', url)
      this.onPageReady(url)
    })
    wc.on('did-navigate-in-page', (_e, url) => {
      console.log('[Xiaohongshu] SPA nav:', url)
      this.onPageReady(url)
    })
    wc.on('did-finish-load', () => {
      this.onPageReady(wc.getURL())
    })
  }

  private onPageReady(url: string): void {
    const isLogin = url.includes('login') && !url.includes('livestream')
    const isLive = url.includes('xiaohongshu.com/livestream') || url.includes('xiaohongshu.com/live')

    if (isLive && !isLogin) {
      if (this.status !== 'connected') {
        this.status = 'connected'
        console.log('[Xiaohongshu] Status: connected')
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
      await this.browserWindow.webContents.executeJavaScript(XHS_CAPTURE_SCRIPT)
    } catch (err: any) {
      console.error('[Xiaohongshu] Injection failed:', err.message)
    }
  }

  // ─── Console-message listener ────────────────────────────────────────────

  private setupConsoleListener(): void {
    if (this.consoleListenerAttached || !this.browserWindow) return
    this.consoleListenerAttached = true

    this.browserWindow.webContents.on('console-message', (_event, _level, message) => {
      // DOM-captured danmaku
      if (message.startsWith('[XHS:DANMAKU]')) {
        const payload = message.substring('[XHS:DANMAKU]'.length)
        try {
          const obj = JSON.parse(payload)
          if (obj.text) {
            console.log('[Xiaohongshu] Danmaku:', obj.userName, ':', obj.text)
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

      // Gift / follow / like events from DOM or WS
      if (message.startsWith('[XHS:EVENT]')) {
        const payload = message.substring('[XHS:EVENT]'.length)
        try {
          const obj = JSON.parse(payload)
          const validTypes = ['gift', 'follow', 'like', 'enter', 'share']
          if (validTypes.includes(obj.type)) {
            this.emitEvent({
              type: obj.type,
              userId: obj.userId || '',
              userName: obj.userName || '',
              text: obj.text || '',
              giftName: obj.giftName,
              count: obj.count || 1,
              timestamp: Date.now()
            })
          }
        } catch { /* skip */ }
        return
      }

      // Diagnostic logs
      if (message.startsWith('[XHS:DIAG]') || message.startsWith('[XHS:OBS]')) {
        console.log('[Xiaohongshu]', message)
        return
      }

      // WebSocket hook (fallback for JSON frames)
      if (message.startsWith('[XHS:WS]')) {
        if (this.debuggerAttached) return
        const payload = message.substring('[XHS:WS]'.length)
        try {
          const data = JSON.parse(payload)
          this.parseAndEmit(data)
        } catch { /* not JSON */ }
        return
      }
    })
  }

  // ─── CDP (secondary: WebSocket frame interception) ─────────────────────────

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
          console.log('[Xiaohongshu] WS created:', (params as any).url)
        }
      })
      console.log('[Xiaohongshu] CDP attached')
    } catch (err: any) {
      console.error('[Xiaohongshu] CDP attach failed:', err.message)
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
      try { data = JSON.parse(payload) } catch { return }
      this.parseAndEmit(data)
    } catch { /* skip */ }
  }

  // ─── Event helpers ────────────────────────────────────────────────────────

  private emitEvent(event: LiveEvent): void {
    if (this.eventCallback) this.eventCallback(event)
  }

  private parseAndEmit(data: any): void {
    if (!this.eventCallback) return

    // Try to parse as a typed message
    if (data.type || data.msg_type || data.msgType || data.cmd) {
      const ev = this.parseTypedMessage(data)
      if (ev) { this.emitEvent(ev); return }
    }

    // Array of messages
    if (data.messages && Array.isArray(data.messages)) {
      for (const m of data.messages) {
        const ev = this.parseTypedMessage(m)
        if (ev) this.emitEvent(ev)
      }
      return
    }

    // Nested data
    if (data.data) {
      const inner = typeof data.data === 'string'
        ? (() => { try { return JSON.parse(data.data) } catch { return null } })()
        : data.data
      if (inner) {
        const ev = this.parseTypedMessage(inner)
        if (ev) { this.emitEvent(ev); return }
      }
    }

    // Fallback: any object with content + nickname
    if (data.content && (data.nickname || data.userName || data.username)) {
      this.emitEvent({
        type: 'danmaku',
        userId: String(data.userId || data.user_id || ''),
        userName: data.nickname || data.userName || data.username || '',
        text: data.content || '',
        timestamp: data.timestamp || Date.now()
      })
    }
  }

  private parseTypedMessage(msg: any): LiveEvent | null {
    const t = String(msg.type || msg.msg_type || msg.msgType || msg.cmd || '').toLowerCase()
    const uid = String(msg.userId || msg.user_id || msg.uid || msg.user?.userId || '')
    const uname = msg.nickname || msg.userName || msg.user_name || msg.username || msg.user?.nickname || msg.user?.userName || ''

    if (t.includes('chat') || t.includes('comment') || t.includes('danmu') || t.includes('barrage') || t === 'msg') {
      const text = msg.content || msg.text || msg.comment || msg.message || ''
      return text ? { type: 'danmaku', userId: uid, userName: uname, text, timestamp: msg.timestamp || Date.now() } : null
    }
    if (t.includes('gift')) {
      return { type: 'gift', userId: uid, userName: uname, giftName: msg.giftName || msg.gift_name || 'gift', count: msg.count || msg.giftCount || 1, timestamp: msg.timestamp || Date.now() }
    }
    if (t.includes('like')) {
      return { type: 'like', userId: uid, userName: uname, count: msg.count || 1, timestamp: msg.timestamp || Date.now() }
    }
    if (t.includes('follow') || t.includes('subscribe')) {
      return { type: 'follow', userId: uid, userName: uname, timestamp: msg.timestamp || Date.now() }
    }
    if (t.includes('enter') || t.includes('join') || t.includes('member')) {
      return { type: 'enter', userId: uid, userName: uname, timestamp: msg.timestamp || Date.now() }
    }
    if (t.includes('share')) {
      return { type: 'share', userId: uid, userName: uname, timestamp: msg.timestamp || Date.now() }
    }
    return null
  }
}

// =============================================================================
// Injected script (runs inside the Xiaohongshu live page context)
// =============================================================================

/**
 * DOM-based danmaku capture for Xiaohongshu Live.
 *
 * Multi-strategy capture:
 * Phase 1: Diagnostic — output page structure info (once)
 * Phase 2: MutationObserver — watch all new DOM nodes
 * Phase 3: Periodic scan — scan scrollable containers for comments
 * Phase 4: WebSocket hook — intercept WS messages for real-time data
 */
const XHS_CAPTURE_SCRIPT = `
(function() {
  if (window.__xhsCaptureV1) return;
  window.__xhsCaptureV1 = true;

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
    console.log('[XHS:DANMAKU]' + JSON.stringify({ userName: userName || '', text: text, userId: userId || '' }));
  }

  function emitEvent(type, userName, text, extra) {
    var obj = { type: type, userName: userName || '', text: text || '', userId: '' };
    if (extra) {
      if (extra.giftName) obj.giftName = extra.giftName;
      if (extra.count) obj.count = extra.count;
    }
    console.log('[XHS:EVENT]' + JSON.stringify(obj));
  }

  // ── Phase 1: Diagnostic ──
  if (!window.__xhsDiagDone) {
    window.__xhsDiagDone = true;
    setTimeout(function() {
      try {
        var iframes = document.querySelectorAll('iframe');
        console.log('[XHS:DIAG] iframes: ' + iframes.length);
        var all = document.body.getElementsByTagName('*');
        console.log('[XHS:DIAG] total elements: ' + all.length);

        // Sample some class names to understand the page structure
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
        console.log('[XHS:DIAG] sample-classes: ' + sampleClasses.join(', '));

        // Find scrollable containers
        var containers = [];
        for (var i = 0; i < all.length; i++) {
          var el = all[i];
          if (el.children.length < 3) continue;
          if (el.scrollHeight <= el.clientHeight + 20) continue;
          if (el.children.length >= 3) {
            var lastChild = el.children[el.children.length - 1];
            containers.push({
              tag: el.tagName,
              cls: (el.className && typeof el.className === 'string') ? el.className.substring(0, 150) : '',
              kids: el.children.length,
              sample: lastChild ? lastChild.textContent.substring(0, 120) : ''
            });
          }
        }
        console.log('[XHS:DIAG] potential containers: ' + containers.length);
        for (var ci = 0; ci < Math.min(containers.length, 15); ci++) {
          var c = containers[ci];
          console.log('[XHS:DIAG]   [' + ci + '] <' + c.tag + '> cls="' + c.cls + '" kids=' + c.kids + ' sample="' + c.sample + '"');
        }
      } catch(e) {
        console.log('[XHS:DIAG] error: ' + e.message);
      }
    }, 3000);
  }

  // ── Phase 2: MutationObserver ──
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

    // Strategy 3: colon-separated
    var colonIdx = full.indexOf('\\uff1a');
    if (colonIdx < 0) {
      var ci = full.indexOf(':');
      if (ci > 0 && ci < 25) colonIdx = ci;
    }
    if (colonIdx > 0 && colonIdx < full.length - 1) {
      emit(full.substring(0, colonIdx).trim(), full.substring(colonIdx + 1).trim(), '');
      return;
    }

    // Strategy 4: span-based extraction (last resort)
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
      }
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
      } else if (parent.parentElement) {
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
    console.log('[XHS:OBS] MutationObserver started');
  } else {
    document.addEventListener('DOMContentLoaded', function() {
      observer.observe(document.body, { childList: true, subtree: true });
      console.log('[XHS:OBS] MutationObserver started (after DOMContentLoaded)');
    });
  }

  // ── Phase 3: Periodic scan ──
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
      console.log('[XHS:OBS] scan #' + scanCount + ' emitted=' + emitCount);
    }
  }
  setInterval(scanContainers, 2000);

  // ── Phase 4: WebSocket hook ──
  if (!window.__xhsWSHooked) {
    window.__xhsWSHooked = true;
    var OrigWS = window.WebSocket;

    window.WebSocket = function(url, protocols) {
      console.log('[XHS:OBS] New WebSocket: ' + url);
      var ws = protocols ? new OrigWS(url, protocols) : new OrigWS(url);

      var origAdd = ws.addEventListener.bind(ws);
      ws.addEventListener = function(type, listener, opts) {
        if (type === 'message') {
          var wrapped = function(event) {
            try {
              if (typeof event.data === 'string' && event.data.length < 5000) {
                console.log('[XHS:WS]' + event.data.substring(0, 2000));
              }
            } catch(e) {}
            return listener.call(this, event);
          };
          return origAdd(type, wrapped, opts);
        }
        return origAdd(type, listener, opts);
      };

      var _onmsg = null;
      Object.defineProperty(ws, 'onmessage', {
        get: function() { return _onmsg; },
        set: function(handler) {
          _onmsg = function(event) {
            try {
              if (typeof event.data === 'string' && event.data.length < 5000) {
                console.log('[XHS:WS]' + event.data.substring(0, 2000));
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

    console.log('[XHS:OBS] WebSocket hook installed');
  }

  console.log('[XHS:OBS] Capture script v1 initialized');
})();
`
