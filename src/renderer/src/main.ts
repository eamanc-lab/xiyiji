import { createApp } from 'vue'
import { createPinia } from 'pinia'
import TDesign from 'tdesign-vue-next'
import 'tdesign-vue-next/es/style/index.css'
import App from './App.vue'
import router from './router'
import i18n from './i18n'
import './assets/styles/global.css'
import { initAntiDebug } from './utils/anti-debug'

// Prevent modal alert storms from blocking the renderer.
// We keep confirm/prompt untouched, only convert alert to non-blocking logs.
{
  let lastAlertAt = 0
  let suppressed = 0
  window.alert = (message?: any): void => {
    const now = Date.now()
    if (now - lastAlertAt < 800) {
      suppressed += 1
      return
    }
    lastAlertAt = now
    if (suppressed > 0) {
      console.error(`[UI ALERT] suppressed=${suppressed}`)
      suppressed = 0
    }
    console.error('[UI ALERT]', message)
  }

  window.addEventListener('error', (event) => {
    console.error('[UI ERROR]', event.error || event.message)
    event.preventDefault()
  })

  window.addEventListener('unhandledrejection', (event) => {
    console.error('[UI UNHANDLED REJECTION]', event.reason)
    event.preventDefault()
  })
}

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.use(TDesign)
app.use(i18n)
app.mount('#app')

initAntiDebug()
