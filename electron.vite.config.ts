import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import { dataUrl } from './scripts/dataUrl.mjs'

export default defineConfig({
  main: {
    build: {
      externalizeDeps: {
        exclude: [
          '@ai-sdk/mcp',
          '@secretlint/core',
          '@secretlint/secretlint-rule-preset-recommend',
          'parse5',
        ],
      },
      rollupOptions: {
        input: { index: resolve('src/main/index.ts') },
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    resolve: {
      alias: {
        '@': resolve('src/renderer'),
        '@shared': resolve('src/shared'),
      },
    },
    build: {
      rollupOptions: {
        input: { index: resolve('src/renderer/index.html') },
      },
    },
    plugins: [dataUrl(), react(), tailwindcss()],
  },
})
