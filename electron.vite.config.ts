import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      sourcemap: false,
      minify: 'terser',
      terserOptions: {
        compress: {
          passes: 2
        },
        format: {
          comments: false
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      sourcemap: false,
      minify: 'terser',
      terserOptions: {
        compress: {
          passes: 2
        },
        format: {
          comments: false
        }
      },
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          player: resolve(__dirname, 'src/preload/player.ts')
        }
      }
    }
  },
  renderer: {
    plugins: [vue()],
    server: {
      hmr: {
        overlay: false
      }
    },
    resolve: {
      alias: {
        '@': resolve('src/renderer/src')
      }
    },
    build: {
      sourcemap: false,
      minify: 'terser',
      terserOptions: {
        compress: {
          passes: 2
        },
        format: {
          comments: false
        }
      },
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          player: resolve(__dirname, 'src/renderer/player.html')
        }
      }
    }
  }
})
