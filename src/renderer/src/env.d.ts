/// <reference types="vite/client" />

export {}

declare global {
  interface Window {
    api: import('../../preload/index').ApiType
  }
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}
