import { Buffer } from 'buffer'

const scope = globalThis as unknown as { Buffer?: unknown; process?: unknown }

scope.Buffer ??= Buffer
scope.process ??= {
  env: {},
  version: 'v20.0.0',
  versions: {},
  browser: true,
  nextTick: (callback: (...args: unknown[]) => void, ...args: unknown[]) =>
    queueMicrotask(() => callback(...args)),
}
