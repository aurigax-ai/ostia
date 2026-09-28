import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ipcMain } from 'electron'
import type { Message } from 'vscode-jsonrpc'
import { StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node'
import type { LspServerInfo, LspStartResult } from '../shared/types'

const SERVERS: Record<string, { cmd: string; args: string[] }> = {
  python: { cmd: 'pyright-langserver', args: ['--stdio'] },
  rust: { cmd: 'rust-analyzer', args: [] },
  go: { cmd: 'gopls', args: [] },
  c: { cmd: 'clangd', args: [] },
  cpp: { cmd: 'clangd', args: [] },
  shell: { cmd: 'bash-language-server', args: ['start'] },
  lua: { cmd: 'lua-language-server', args: [] },
  json: { cmd: 'vscode-json-language-server', args: ['--stdio'] },
  yaml: { cmd: 'yaml-language-server', args: ['--stdio'] },
}

const ROOT_MARKERS = [
  '.git',
  'package.json',
  'go.mod',
  'Cargo.toml',
  'pyproject.toml',
  'setup.py',
  'requirements.txt',
  'compile_commands.json',
  '.luarc.json',
  'tsconfig.json',
]

function which(cmd: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (dir && existsSync(join(dir, cmd))) return join(dir, cmd)
  }
  return null
}

function findRoot(startDir: string): string {
  let dir = startDir
  for (let i = 0; i < 40; i++) {
    if (ROOT_MARKERS.some((m) => existsSync(join(dir, m)))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return startDir
}

interface Server {
  proc: ChildProcessWithoutNullStreams
  writer: StreamMessageWriter
  wc: Electron.WebContents
}

const servers = new Map<string, Server>()

export function registerLspIpc(): void {
  ipcMain.handle('lsp:list', (): LspServerInfo[] =>
    Object.entries(SERVERS).map(([languageId, { cmd }]) => ({
      languageId,
      command: cmd,
      installed: which(cmd) !== null,
    })),
  )

  ipcMain.handle('lsp:start', (e, languageId: string, filePath: string): LspStartResult | null => {
    const server = SERVERS[languageId]
    if (!server || !which(server.cmd)) return null
    const root = findRoot(dirname(filePath))
    const id = `${languageId}::${root}`

    const existing = servers.get(id)
    if (existing) {
      existing.wc = e.sender
      return { id, root }
    }

    let proc: ChildProcessWithoutNullStreams
    try {
      proc = spawn(server.cmd, server.args, { cwd: root, env: process.env })
    } catch {
      return null
    }
    const reader = new StreamMessageReader(proc.stdout)
    const writer = new StreamMessageWriter(proc.stdin)
    const entry: Server = { proc, writer, wc: e.sender }
    servers.set(id, entry)

    reader.listen((msg) => {
      if (!entry.wc.isDestroyed()) entry.wc.send(`lsp:msg:${id}`, msg)
    })
    reader.onError(() => {})
    proc.stderr.on('data', () => {})
    const cleanup = (): void => {
      servers.delete(id)
      if (!entry.wc.isDestroyed()) entry.wc.send(`lsp:exit:${id}`)
    }
    proc.on('exit', cleanup)
    proc.on('error', () => servers.delete(id))

    return { id, root }
  })

  ipcMain.on('lsp:send', (_e, id: string, message: Message) => {
    servers
      .get(id)
      ?.writer.write(message)
      .catch(() => {})
  })

  ipcMain.on('lsp:stop', (_e, id: string) => {
    const s = servers.get(id)
    if (!s) return
    try {
      s.proc.kill()
    } catch {}
    servers.delete(id)
  })
}

export function killAllLsp(): void {
  for (const s of servers.values()) {
    try {
      s.proc.kill()
    } catch {}
  }
  servers.clear()
}
