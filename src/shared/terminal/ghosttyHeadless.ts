import { Ghostty, HeadlessTerminal, type HeadlessTerminalOptions } from '@aurigax-ai/ghostty-web'
import wasmBytes from '@aurigax-ai/ghostty-web/ghostty-vt.wasm'

let engine: Ghostty | undefined

function ghostty(): Ghostty {
  engine ??= new Ghostty(new WebAssembly.Instance(new WebAssembly.Module(wasmBytes), {}))
  return engine
}

export function createHeadlessTerminal(
  options: Omit<HeadlessTerminalOptions, 'ghostty'>,
): HeadlessTerminal {
  return new HeadlessTerminal({ ...options, ghostty: ghostty() })
}
