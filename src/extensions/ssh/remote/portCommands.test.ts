import { describe, expect, it, vi } from 'vitest'
import { portCommands } from './portCommands'
import { RemoteRegistry } from './registry'

function setup() {
  const registry = new RemoteRegistry(null)
  registry.addWorkspace('w1', { host: 'box', folder: '~', agent: 'claude' })
  const forwards = {
    list: vi.fn(() => ({
      ok: true as const,
      forwards: [{ remote: 3000, local: 3100, name: 'node' }],
    })),
    forward: vi.fn(async (remote: number, local?: number) => ({
      ok: true as const,
      forwards: [{ remote, local: local ?? remote }],
    })),
    stop: vi.fn(async () => ({ ok: true as const, forwards: [] })),
  }
  const commands = portCommands({
    registry,
    forwards: (host) => (host === 'box' ? (forwards as never) : undefined),
  })
  return { commands, forwards }
}

const caller = { kind: 'pane' as const, capabilities: ['process' as const], workspaceId: 'w1' }

describe('port commands', () => {
  it('RPF-C19 forwards the port with the asked local port and answers the observed rows', async () => {
    const { commands, forwards } = setup()
    const res = await commands['ports-forward']({ argv: ['3000', '--local', '3100'] }, caller)
    expect(forwards.forward).toHaveBeenCalledWith(3000, 3100)
    expect(res).toMatchObject({ ok: true, data: { forwards: [{ remote: 3000, local: 3100 }] } })
  })

  it('RPF-C14 reads the chip JSON with an empty local port as auto', async () => {
    const { commands, forwards } = setup()
    await commands['ports-forward']({ argv: ['{"remote":8080}'] }, caller)
    expect(forwards.forward).toHaveBeenCalledWith(8080, undefined)
  })

  it('RPF-C23 answers not-remote for a workspace that is not an ssh remote workspace', async () => {
    const { commands, forwards } = setup()
    const res = await commands['ports-forward'](
      { argv: ['3000'] },
      { ...caller, workspaceId: 'local' },
    )
    expect(res).toMatchObject({ ok: false, error: 'not-remote' })
    expect(forwards.forward).not.toHaveBeenCalled()
  })

  it('RPF-C22 answers link-down when the host has no running link', async () => {
    const registry = new RemoteRegistry(null)
    registry.addWorkspace('w1', { host: 'box', folder: '~', agent: 'claude' })
    const commands = portCommands({ registry, forwards: () => undefined })
    expect(await commands['ports-list']({ argv: [] }, caller)).toMatchObject({
      ok: false,
      error: 'link-down',
    })
  })

  it('RPF-C21 refuses a malformed request before anything changes', async () => {
    const { commands, forwards } = setup()
    for (const argv of [['x'], ['3000', '--local', 'x'], ['3000', '4000'], []]) {
      const res = await commands['ports-forward']({ argv }, caller)
      expect(res).toMatchObject({ ok: false })
    }
    expect(forwards.forward).not.toHaveBeenCalled()
  })

  it('lists and stops', async () => {
    const { commands, forwards } = setup()
    expect(await commands['ports-list']({ argv: [] }, caller)).toMatchObject({
      ok: true,
      text: '3000\t3100\tnode\t-',
    })
    await commands['ports-stop']({ argv: ['3000'] }, caller)
    expect(forwards.stop).toHaveBeenCalledWith(3000)
  })

  it('RPF-C18 gives an agent no command that changes the forwarding setting', async () => {
    const { commands } = setup()
    expect(Object.keys(commands).sort()).toEqual(['ports-forward', 'ports-list', 'ports-stop'])
    const res = await commands['ports-forward'](
      { argv: ['{"remote":3000,"portForwarding":"manual"}'] },
      caller,
    )
    expect(res).toMatchObject({ ok: true })
  })
})
