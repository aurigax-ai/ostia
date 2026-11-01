import { readFile } from 'node:fs/promises'

export function wasmBytesPlugin() {
  return {
    name: 'wasm-bytes',
    enforce: 'pre',
    async load(id) {
      if (!id.endsWith('.wasm')) return null
      const base64 = (await readFile(id)).toString('base64')
      return `export default Uint8Array.from(atob(${JSON.stringify(base64)}), (c) => c.charCodeAt(0))`
    },
  }
}
