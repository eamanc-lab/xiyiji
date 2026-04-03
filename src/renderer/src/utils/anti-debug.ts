/**
 * 渲染进程反调试模块
 * 生产环境下定时检测 DevTools 是否被打开
 */
export function initAntiDebug(): void {
  if (import.meta.env.DEV) return

  setInterval(() => {
    const start = performance.now()
    // eslint-disable-next-line no-debugger
    debugger
    if (performance.now() - start > 100) {
      document.body.innerHTML = ''
      location.reload()
    }
  }, 3000)
}
