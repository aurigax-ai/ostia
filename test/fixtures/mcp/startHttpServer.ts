import { type ChildProcess, spawn } from 'node:child_process'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

export const FAKE_MCP_SERVER = join(__dirname, 'fake-server.mjs')

export interface FakeMcpStats {
  registrations: number
  authorizations: number
  exchanges: number
  refreshes: number
  calls: number
}

export interface FakeMcpHttp {
  url: string
  origin: string
  stats: () => Promise<FakeMcpStats>
  control: (action: 'expire' | 'revoke' | 'deny') => Promise<FakeMcpStats>
  close: () => void
}

export function startFakeMcpHttp(
  opts: { oauth?: boolean; tokenTtl?: number } = {},
): Promise<FakeMcpHttp> {
  const args = [FAKE_MCP_SERVER, '--http']
  if (opts.oauth) args.push('--oauth')
  if (opts.tokenTtl !== undefined) args.push('--token-ttl', String(opts.tokenTtl))
  const child: ChildProcess = spawn(process.execPath, args, {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => reject(new Error(`fake MCP server exited with ${code}`)))
    if (!child.stdout) return
    createInterface({ input: child.stdout }).once('line', (line) => {
      const { url } = JSON.parse(line) as { url: string }
      const origin = new URL(url).origin
      const stats = async (action?: string): Promise<FakeMcpStats> => {
        const res = await fetch(`${origin}/control`, {
          method: action ? 'POST' : 'GET',
          body: action ? JSON.stringify({ action }) : undefined,
        })
        return (await res.json()) as FakeMcpStats
      }
      resolve({
        url,
        origin,
        stats: () => stats(),
        control: (action) => stats(action),
        close: () => child.kill(),
      })
    })
  })
}
