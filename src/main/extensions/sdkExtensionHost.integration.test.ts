import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ExtensionCaller } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { CommandResult } from '../../shared/types'
import { registerControlServer, stopControlServer } from '../control/controlServer'
import { ExtensionHost } from './extensionHost'
import { registerExtensionMethods } from './extensionMethods'
import { ExtensionStore } from './extensionStore'

const repoRoot = resolve(__dirname, '../../..')
const sdkPackage = join(repoRoot, 'out/sdk')

describe('an extension made from the SDK template', () => {
  let project: string

  beforeAll(() => {
    project = mkdtempSync(join(tmpdir(), 'ostia-sdk-host-project-'))
    execFileSync(process.execPath, [join(sdkPackage, 'dist/cli.cjs'), 'create', 'hello', project], {
      stdio: 'ignore',
    })
    const link = (name: string, target: string): void => {
      const path = join(project, 'node_modules', name)
      mkdirSync(resolve(path, '..'), { recursive: true })
      symlinkSync(target, path, 'dir')
    }
    link('@aurigax-ai/ostia-extension-sdk', sdkPackage)
    for (const name of ['esbuild', '@types/node']) link(name, join(repoRoot, 'node_modules', name))
    execFileSync(process.execPath, ['build.mjs'], { cwd: project, stdio: 'ignore' })
  }, 60_000)

  afterAll(() => {
    rmSync(project, { recursive: true, force: true })
  })

  it('runs the built extension in the extension host and answers its command', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ostia-sdk-host-'))
    const socketPath = join(dir, 'control.sock')
    const notify = vi.fn()
    let language = 'en'
    const host = new ExtensionHost({
      locale: () => language,
      roots: [{ dir: join(project, 'dist'), builtin: true }],
      store: new ExtensionStore(join(dir, 'extensions.json')),
      socketPath: () => socketPath,
      nodePath: process.execPath,
      workDirForWorkspace: () => undefined,
      broadcast: () => {},
      openPanelIn: () => {},
      notify,
      readyTimeoutMs: 8000,
      requestTimeoutMs: 4000,
      log: () => {},
    })
    registerExtensionMethods(() => host)
    registerControlServer(
      {
        execCommand: async () => ({ ok: true, result: null }) as CommandResult,
        listCommandsFor: () => [],
        getTerminalState: () => undefined,
        isSandboxed: () => false,
      },
      socketPath,
    )
    const caller: ExtensionCaller = { kind: 'user', workspaceId: 's1', capabilities: [] }
    try {
      expect(await host.invoke('hello', 'greet', { argv: ['you'] }, caller)).toMatchObject({
        ok: true,
        text: 'Hello, you',
        data: { name: 'you' },
      })
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Hello', body: 'Hello, you' }),
      )
      expect(await host.invoke('hello', 'greet', { argv: [] }, caller)).toMatchObject({
        ok: false,
        error: 'invalid-args',
        message: 'greet <name>',
      })
      expect(
        await host.invoke('hello', 'greet', { argv: ['you'] }, { ...caller, locale: 'zh-Hant' }),
      ).toMatchObject({ ok: true, text: '你好，you' })
      expect(notify).toHaveBeenLastCalledWith(
        expect.objectContaining({ title: '哈囉', body: '你好，you' }),
      )
      const title = (): string | undefined =>
        host.list().find((e) => e.id === 'hello')?.commands[0].title
      expect(title()).toBe('Hello: Greet')
      language = 'zh-Hant'
      expect(title()).toBe('哈囉：打招呼')
    } finally {
      host.stopAll()
      stopControlServer()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})
