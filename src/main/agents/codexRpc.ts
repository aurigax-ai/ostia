import { PRODUCT_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/product'
import WebSocket from 'ws'

export interface CodexRpc {
  request: (method: string, params: unknown) => Promise<unknown>
  close: () => void
  closed: Promise<void>
}

const REQUEST_TIMEOUT_MS = 15_000
const CONNECT_TIMEOUT_MS = 5000

interface Pending {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

export type CodexNotice = (method: string, params: unknown) => void

export function connectCodexRpc(
  socketPath: string,
  version: string,
  onNotice?: CodexNotice,
): Promise<CodexRpc> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws+unix://${socketPath}:/`, { handshakeTimeout: CONNECT_TIMEOUT_MS })
    const pending = new Map<number, Pending>()
    let nextId = 0
    let onClosed: () => void = () => {}
    const closed = new Promise<void>((done) => {
      onClosed = done
    })
    const fail = (err: Error): void => {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer)
        entry.reject(err)
      }
      pending.clear()
    }
    const request = (method: string, params: unknown): Promise<unknown> =>
      new Promise((res, rej) => {
        const id = ++nextId
        const timer = setTimeout(() => {
          pending.delete(id)
          rej(new Error(`${method} timed out`))
        }, REQUEST_TIMEOUT_MS)
        pending.set(id, { resolve: res, reject: rej, timer })
        ws.send(JSON.stringify({ id, method, params }), (err) => {
          if (!err) return
          clearTimeout(timer)
          pending.delete(id)
          rej(err)
        })
      })
    ws.on('message', (data) => {
      let message: {
        id?: number
        method?: string
        params?: unknown
        result?: unknown
        error?: { message?: string }
      }
      try {
        message = JSON.parse(String(data))
      } catch (err) {
        if (err instanceof SyntaxError) return
        throw err
      }
      if (typeof message !== 'object' || message === null) return
      if (typeof message.method === 'string') {
        if (message.id === undefined) onNotice?.(message.method, message.params)
        return
      }
      const entry = message.id === undefined ? undefined : pending.get(message.id)
      if (!entry || message.id === undefined) return
      pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.error) entry.reject(new Error(message.error.message ?? 'codex refused'))
      else entry.resolve(message.result)
    })
    ws.on('close', () => {
      fail(new Error('codex closed the connection'))
      onClosed()
    })
    ws.on('error', (err) => {
      fail(err)
      reject(err)
    })
    ws.on('open', () => {
      const client: CodexRpc = { request, close: () => ws.close(), closed }
      request('initialize', { clientInfo: { name: PRODUCT_NAME, title: PRODUCT_NAME, version } })
        .then(() => {
          ws.send(JSON.stringify({ method: 'initialized' }))
          resolve(client)
        })
        .catch((err) => {
          ws.close()
          reject(err)
        })
    })
  })
}
