import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import { pageScriptPlugin } from './scripts/pageScriptPlugin.mjs'
import { wasmBytesPlugin } from './scripts/wasmBytesPlugin.mjs'

export default defineConfig({
  main: {
    plugins: [pageScriptPlugin(), wasmBytesPlugin()],
    build: {
      externalizeDeps: {
        exclude: [
          '@ai-sdk/mcp',
          '@aurigax-ai/ghostty-web',
          '@secretlint/core',
          '@secretlint/secretlint-rule-preset-recommend',
          'papaparse',
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
    assetsInclude: ['**/*.wasm'],
    plugins: [react(), tailwindcss()],
  },
})
