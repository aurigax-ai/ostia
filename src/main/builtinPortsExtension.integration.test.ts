import { type ChildProcess, spawn } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { type Server, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ExtensionCaller, ExtensionSidebarItem } from '../shared/extensions'
import type { CommandResult } from '../shared/types'
import { registerControlServer, stopControlServer } from './controlServer'
import { ExtensionHost, registerExtensionMethods } from './extensionHost'
import { ExtensionStore } from './extensionStore'
import { registerPane } from './idRegistry'
import { registerPaneListMethods } from './paneList'

const repoRoot = process.cwd()

async function until<T>(read: () => T | undefined, timeoutMs = 15_000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 50))
  }
}

function firstLine(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8')
      const nl = out.indexOf('\n')
      if (nl >= 0) resolve(out.slice(0, nl).trim())
    })
    child.once('error', reject)
  })
}

const LISTENER =
  "require('node:net').createServer().listen(0, '127.0.0.1', function () { console.log(this.address().port) })"

describe.runIf(process.platform === 'linux')(
  'built-in ports extension against real processes',
  () => {
    let dir: string
    let host: ExtensionHost
    let web: ChildProcess
    let remote: ChildProcess
    let inheritor: ChildProcess
    let hostServer: Server
    let port = 0
    const broadcasts: { channel: string; payload: unknown }[] = []
    const sidebar = (): ExtensionSidebarItem[] =>
      (broadcasts.filter((b) => b.channel === 'extensions:sidebar').at(-1)?.payload ??
        []) as ExtensionSidebarItem[]
    const itemsOf = (workspaceId: string): ExtensionSidebarItem[] =>
      sidebar().filter((i) => i.extId === 'ports' && i.workspaceId === workspaceId)

    beforeAll(async () => {
      dir = realpathSync(mkdtempSync(join(tmpdir(), 'pine-ports-ext-')))
      const extDir = join(dir, 'extensions', 'ports')
      mkdirSync(extDir, { recursive: true })
      copyFileSync(join(repoRoot, 'src/extensions/ports/pine.json'), join(extDir, 'pine.json'))
      await build({
        entryPoints: [join(repoRoot, 'src/extensions/ports/main.ts')],
        outfile: join(extDir, 'main.js'),
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node20',
        logLevel: 'warning',
      })

      const bin = join(dir, 'bin')
      mkdirSync(bin)
      writeFileSync(join(bin, 'ssh'), '#!/bin/sh\nsleep 60\n')
      chmodSync(join(bin, 'ssh'), 0o755)

      web = spawn('sh', ['-c', `"${process.execPath}" -e "${LISTENER}"; true`], {
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      port = Number(await firstLine(web))
      remote = spawn(
        'script',
        ['-qfec', `sh -c '${join(bin, 'ssh')} -p 2222 deploy@build-box'`, '/dev/null'],
        {
          stdio: ['pipe', 'ignore', 'ignore'],
        },
      )

      hostServer = createServer()
      await new Promise<void>((r) => hostServer.listen(0, '127.0.0.1', r))
      const hostFd = (hostServer as unknown as { _handle: { fd: number } })._handle.fd
      inheritor = spawn('sh', ['-c', 'sleep 60; true'], {
        stdio: ['ignore', 'ignore', 'ignore', hostFd],
      })

      const socketPath = join(dir, 'control.sock')
      registerPane({ windowId: 'w1', workspaceId: 's4', paneId: 'p-inherit' })
      registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'p-web' })
      registerPane({ windowId: 'w1', workspaceId: 's2', paneId: 'p-ssh' })
      registerPane({ windowId: 'w1', workspaceId: 's3', paneId: 'p-idle' })
      const pids: Record<string, number | undefined> = {
        'p-web': web.pid,
        'p-ssh': remote.pid,
        'p-idle': process.pid,
        'p-inherit': inheritor.pid,
      }
      registerPaneListMethods({
        execCommand: async () =>
          ({
            ok: true,
            result: [
              { paneId: 'p-web', workspaceId: 's1', kind: 'terminal', title: 'zsh' },
              { paneId: 'p-ssh', workspaceId: 's2', kind: 'terminal', title: 'zsh' },
              { paneId: 'p-idle', workspaceId: 's3', kind: 'editor', title: 'a.ts' },
              { paneId: 'p-inherit', workspaceId: 's4', kind: 'terminal', title: 'zsh' },
            ],
          }) as CommandResult,
        getTerminalState: () => undefined,
        ptyPid: (paneId) => pids[paneId],
      })
      host = new ExtensionHost({
        roots: [{ dir: join(dir, 'extensions'), builtin: true }],
        store: new ExtensionStore(join(dir, 'extensions.json')),
        socketPath: () => socketPath,
        nodePath: process.execPath,
        workDirForWorkspace: () => dir,
        broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
        openPanelIn: () => {},
        openDiffIn: () => {},
        notify: () => {},
        log: () => {},
      })
      registerExtensionMethods(() => host)
      registerControlServer(
        {
          execCommand: async () => ({ ok: true, result: null }) as CommandResult,
          listCommandsFor: () => [],
          getTerminalState: () => undefined,
        },
        socketPath,
      )
      host.startEager()
    })

    afterAll(() => {
      host?.stopAll()
      stopControlServer()
      web?.kill('SIGKILL')
      remote?.kill('SIGKILL')
      inheritor?.kill('SIGKILL')
      hostServer?.close()
      rmSync(dir, { recursive: true, force: true })
    })

    it('shows the port a process in the pane’s tree listens on, linked to localhost', async () => {
      const item = await until(() => itemsOf('s1').find((i) => i.key === `port:${port}`))
      expect(item).toMatchObject({ text: `:${port}`, url: `http://localhost:${port}/` })
    })

    it('shows the host of a foreground ssh and no ports for it', async () => {
      const item = await until(() => itemsOf('s2').find((i) => i.key === 'ssh'))
      expect(item).toMatchObject({ text: 'build-box', icon: 'server' })
      expect(itemsOf('s2').some((i) => i.key.startsWith('port:'))).toBe(false)
    })

    it('ignores a listening socket the terminal only inherited from Pine itself', async () => {
      await until(() => itemsOf('s1')[0])
      await until(() => itemsOf('s2')[0])
      expect(itemsOf('s4')).toEqual([])
    })

    it('never scans panes that are not terminals', async () => {
      await until(() => itemsOf('s1')[0])
      expect(itemsOf('s3')).toEqual([])
    })

    it('answers ls with the caller’s workspace only unless it may see all', async () => {
      const caller = (caps: ExtensionCaller['capabilities']): ExtensionCaller => ({
        kind: 'pane',
        workspaceId: 's1',
        capabilities: caps,
      })
      const own = await host.invoke('ports', 'ls', { argv: [] }, caller(['read-board']))
      expect(own).toEqual({
        ok: true,
        data: { workspaces: [{ workspaceId: 's1', ports: [port], ssh: [] }] },
      })
      expect(
        await host.invoke('ports', 'ls', { argv: ['--all'] }, caller(['read-board'])),
      ).toMatchObject({ ok: false, error: 'needs-elevation' })
      const all = await host.invoke(
        'ports',
        'ls',
        { argv: ['--all'] },
        caller(['read-board', 'all-workspaces']),
      )
      expect(
        all.ok &&
          (all.data as { workspaces: { workspaceId: string }[] }).workspaces
            .map((w) => w.workspaceId)
            .sort(),
      ).toEqual(['s1', 's2', 's4'])
    })

    it('drops the port once the listener exits', async () => {
      await until(() => itemsOf('s1')[0])
      web.kill('SIGKILL')
      await until(() => (itemsOf('s1').length === 0 ? true : undefined))
    })
  },
)
