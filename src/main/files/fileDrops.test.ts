import { describe, expect, it, vi } from 'vitest'
import { type FileDropsDeps, importDropped } from './fileDrops'

vi.mock('electron', () => ({ ipcMain: {}, nativeImage: {} }))

function deps(refusal: string | null): FileDropsDeps & { importInto: ReturnType<typeof vi.fn> } {
  const importInto = vi.fn().mockResolvedValue({ ok: true, paths: ['/w/a.txt'] })
  return {
    importInto,
    fileOps: { importInto, draggable: vi.fn() },
    windowOfWorkspace: (workspaceId) => (workspaceId === 'ws1' ? '7' : undefined),
    sandboxRefusal: () => refusal,
  }
}

const request = { paths: ['/tmp/a.txt'], dir: '/w', workspaceId: 'ws1', move: true }

describe('importDropped', () => {
  it('imports into a workspace of the sending window and passes the move choice', async () => {
    const d = deps(null)
    expect(await importDropped(d, '7', request)).toEqual({ ok: true, paths: ['/w/a.txt'] })
    expect(d.importInto).toHaveBeenCalledWith(['/tmp/a.txt'], '/w', true)
    await importDropped(d, '7', { ...request, move: 'yes' })
    expect(d.importInto).toHaveBeenLastCalledWith(['/tmp/a.txt'], '/w', false)
  })

  it('refuses a sandboxed workspace whose write rules leave the folder out, and changes nothing', async () => {
    for (const refusal of ['outside', 'read-only']) {
      const d = deps(refusal)
      expect(await importDropped(d, '7', request)).toEqual({ ok: false, error: 'sandboxed' })
      expect(d.importInto).not.toHaveBeenCalled()
    }
  })

  it('refuses a workspace another window owns or a malformed request', async () => {
    const d = deps(null)
    expect(await importDropped(d, '8', request)).toEqual({ ok: false, error: 'outside' })
    expect(await importDropped(d, '7', { ...request, workspaceId: 'ws2' })).toEqual({
      ok: false,
      error: 'outside',
    })
    expect(await importDropped(d, '7', { ...request, dir: 3 })).toEqual({
      ok: false,
      error: 'outside',
    })
    expect(d.importInto).not.toHaveBeenCalled()
  })
})
