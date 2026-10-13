import { type ChildProcess, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { CoreItems } from '../../shared/boards/git'
import { DEFAULT_PORTS_SETTINGS } from '../../shared/boards/ports'
import type { PaneEntry } from '../panes/paneList'
import { PORTS_ITEMS_CHANNEL, PortsService } from './service'

const SERVER = `require('node:net')
  .createServer()
  .listen(0, '127.0.0.1', function () { console.log(process.pid, this.address().port) })
`

const pane = (paneId: string, workspaceId: string, pid: number | undefined): PaneEntry => ({
  paneId,
  workspaceId,
  kind: 'terminal',
  title: 'sh',
  running: true,
  blockCount: 0,
  pid,
})

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

function inTerminal(command: string, cwd: string): ChildProcess {
  return process.platform === 'darwin'
    ? spawn('script', ['-q', '/dev/null', 'sh', '-c', command], { cwd, stdio: 'ignore' })
    : spawn('script', ['-qfec', command, '/dev/null'], {
        cwd,
        stdio: ['pipe', 'ignore', 'ignore'],
      })
}

describe.skipIf(process.platform !== 'linux' && process.platform !== 'darwin')(
  'PortsService against real processes',
  () => {
    let dir: string
    let shell: ChildProcess
    let remote: ChildProcess
    let service: PortsService
    let serverPid = 0
    let port = 0
    const sent: CoreItems[] = []
    const items = (): CoreItems | undefined => sent.at(-1)

    beforeAll(async () => {
      dir = realpathSync(mkdtempSync(join(tmpdir(), 'ostia-ports-')))
      const bin = join(dir, 'bin')
      mkdirSync(bin)
      writeFileSync(join(dir, 'server.js'), SERVER)
      symlinkSync('/bin/sh', join(bin, 'ssh'))
      writeFileSync(join(dir, 'deploy@build-box'), 'sleep 60\n')
      shell = spawn('sh', ['-c', `"${process.execPath}" "${join(dir, 'server.js')}"; sleep 60`], {
        stdio: ['ignore', 'pipe', 'ignore'],
        detached: true,
      })
      const [pid, listening] = (await firstLine(shell)).split(' ').map(Number)
      serverPid = pid
      port = listening
      remote = inTerminal(`${join(bin, 'ssh')} deploy@build-box`, dir)
      service = new PortsService({
        settings: () => ({ ...DEFAULT_PORTS_SETTINGS, intervalSeconds: 1, portHost: '127.0.0.1' }),
        listPanes: async () => [pane('p-web', 's1', shell.pid), pane('p-ssh', 's2', remote.pid)],
        rendererPaneId: (paneId) => paneId,
        send: (_windowId, channel, payload) => {
          if (channel === PORTS_ITEMS_CHANNEL) sent.push(payload as CoreItems)
        },
      })
    })

    afterAll(() => {
      service?.stop()
      if (shell?.pid) process.kill(-shell.pid, 'SIGKILL')
      remote?.kill('SIGKILL')
      rmSync(dir, { recursive: true, force: true })
    })

    it('listening ports show as a plug in the top bar that opens the browser pane, and an ssh login shows on its pane', async () => {
      service.watch('w1', ['s1', 's2'])
      await vi.waitFor(
        () => {
          expect(items()?.workspaceChips).toHaveLength(1)
          expect(items()?.paneChips).toHaveLength(1)
        },
        { timeout: 20_000, interval: 100 },
      )
      expect(items()?.workspaceChips).toEqual([
        {
          extId: 'ports',
          tone: 'neutral',
          workspaceId: 's1',
          id: 'ports',
          icon: 'plugs',
          text: '1',
          items: [{ text: `:${port}`, url: `http://127.0.0.1:${port}/` }],
        },
      ])
      expect(items()?.paneChips).toEqual([
        { extId: 'ports', tone: 'brand', paneId: 'p-ssh', id: 'ssh', text: 'deploy@build-box' },
      ])
      expect(items()?.sidebar.map((item) => item.text)).toEqual(['build-box'])

      process.kill(serverPid, 'SIGINT')
      await vi.waitFor(() => expect(items()?.workspaceChips).toEqual([]), {
        timeout: 20_000,
        interval: 100,
      })
      expect(shell.exitCode).toBeNull()
      expect(items()?.paneChips.map((chip) => chip.text)).toEqual(['deploy@build-box'])
    })
  },
)
