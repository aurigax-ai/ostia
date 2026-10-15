import { describe, expect, it, vi } from 'vitest'
import { type FileGuardDeps, guardFileOps } from './fileGuard'

const ok = { ok: true, paths: ['/w/a.txt'] }

function setup(refusal: (path: string) => string | null = () => null) {
  const fileOps = {
    create: vi.fn().mockResolvedValue(ok),
    rename: vi.fn().mockResolvedValue(ok),
    move: vi.fn().mockResolvedValue(ok),
    copy: vi.fn().mockResolvedValue(ok),
    trash: vi.fn().mockResolvedValue(ok),
    importInto: vi.fn().mockResolvedValue(ok),
    draggable: vi.fn().mockResolvedValue('/w/a.txt'),
  }
  const deps: FileGuardDeps = {
    fileOps,
    windowOfWorkspace: (workspaceId) => (workspaceId === 'ws1' ? '7' : undefined),
    sandboxRefusal: (_workspaceId, path) => refusal(path),
  }
  return { fileOps, ops: guardFileOps(deps) }
}

type Ops = ReturnType<typeof setup>['ops']
type Call = (ops: Ops, senderId: string, workspaceId: unknown) => Promise<unknown>

const changing: Record<string, Call> = {
  create: (ops, s, w) => ops.create(s, w, '/w', 'n', 'file'),
  rename: (ops, s, w) => ops.rename(s, w, '/w/a.txt', 'b.txt'),
  move: (ops, s, w) => ops.move(s, w, ['/w/a.txt'], '/w/d'),
  copy: (ops, s, w) => ops.copy(s, w, ['/w/a.txt'], '/w/d'),
  trash: (ops, s, w) => ops.trash(s, w, ['/w/a.txt']),
  importInto: (ops, s, w) => ops.importInto(s, w, ['/tmp/a.txt'], '/w', true),
}

describe('guardFileOps', () => {
  it.each(Object.entries(changing))('%s runs for the owner window', async (name, call) => {
    const { fileOps, ops } = setup()
    expect(await call(ops, '7', 'ws1')).toEqual(ok)
    expect(fileOps[name as keyof typeof fileOps]).toHaveBeenCalledTimes(1)
  })

  it.each(Object.entries(changing))(
    '%s refuses a window that does not own the workspace',
    async (name, call) => {
      const { fileOps, ops } = setup()
      expect(await call(ops, '8', 'ws1')).toEqual({ ok: false, error: 'outside' })
      expect(await call(ops, '7', 'ws2')).toEqual({ ok: false, error: 'outside' })
      expect(await call(ops, '7', 3)).toEqual({ ok: false, error: 'outside' })
      expect(fileOps[name as keyof typeof fileOps]).not.toHaveBeenCalled()
    },
  )

  it.each(Object.entries(changing))(
    '%s refuses a path the sandbox write rules leave out',
    async (name, call) => {
      for (const reason of ['outside', 'read-only']) {
        const { fileOps, ops } = setup(() => reason)
        expect(await call(ops, '7', 'ws1')).toEqual({ ok: false, error: 'sandboxed' })
        expect(fileOps[name as keyof typeof fileOps]).not.toHaveBeenCalled()
      }
    },
  )

  it('checks every source and the destination of a move', async () => {
    const { fileOps, ops } = setup((path) => (path === '/etc/x' ? 'outside' : null))
    expect(await ops.move('7', 'ws1', ['/w/a.txt', '/etc/x'], '/w/d')).toEqual({
      ok: false,
      error: 'sandboxed',
    })
    expect(await ops.move('7', 'ws1', ['/w/a.txt'], '/etc/x')).toEqual({
      ok: false,
      error: 'sandboxed',
    })
    expect(fileOps.move).not.toHaveBeenCalled()
  })

  it('refuses a relative path or malformed targets before the sandbox is asked', async () => {
    const { fileOps, ops } = setup()
    expect(await ops.trash('7', 'ws1', ['a.txt'])).toEqual({ ok: false, error: 'outside' })
    expect(await ops.trash('7', 'ws1', [4])).toEqual({ ok: false, error: 'outside' })
    expect(fileOps.trash).not.toHaveBeenCalled()
  })

  it('passes the move choice to an import', async () => {
    const { fileOps, ops } = setup()
    await ops.importInto('7', 'ws1', ['/tmp/a.txt'], '/w', 'yes')
    expect(fileOps.importInto).toHaveBeenCalledWith(['/tmp/a.txt'], '/w', false)
  })

  it('starts a drag only for the owner window and an allowed path', async () => {
    const owned = setup()
    expect(await owned.ops.draggable('7', 'ws1', '/w/a.txt')).toBe('/w/a.txt')
    expect(await owned.ops.draggable('8', 'ws1', '/w/a.txt')).toBeNull()
    const sandboxed = setup(() => 'outside')
    expect(await sandboxed.ops.draggable('7', 'ws1', '/w/a.txt')).toBeNull()
    expect(sandboxed.fileOps.draggable).not.toHaveBeenCalled()
  })
})
