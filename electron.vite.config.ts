import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { fontDataUrl } from './scripts/fontDataUrl.mjs'

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({
        exclude: [
          '@ai-sdk/mcp',
          '@secretlint/core',
          '@secretlint/secretlint-rule-preset-recommend',
        ],
      }),
    ],
    build: {
      rollupOptions: {
        input: { index: resolve('src/main/index.ts') },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
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
    plugins: [fontDataUrl(), react(), tailwindcss()],
  },
})
