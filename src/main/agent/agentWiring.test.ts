import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ControlMethodContext } from '../control/controlServer'
import type { ExtensionHost } from '../extensions/extensionHost'
import { startAgent } from './agentWiring'

type Handler = (params: unknown, ctx: ControlMethodContext) => unknown
const registered = new Map<string, { handler: Handler; cap?: string }>()

vi.mock('../control/controlServer', () => ({
  callControlMethod: vi.fn(),
  registerControlMethod: (name: string, method: { handler: Handler; cap?: string }) =>
    registered.set(name, method),
}))
vi.mock('./agentIpc', () => ({ registerAgentIpc: () => undefined }))
vi.mock('../platform/settingsFile', () => ({ readSettingsFile: () => ({}) }))

const ctx = {} as ControlMethodContext

function wire(builtin: string | null) {
  const complete = vi.fn(async () => ({ ok: true, text: 'answer' }))
  const services = {
    extensionHost: { builtinId: () => builtin } as unknown as ExtensionHost,
    agentSessions: null as unknown,
  }
  startAgent({
    services: services as never,
    redactor: { text: async (t: string) => t } as never,
    workspaceSandboxes: { isEnabled: () => false },
    registry: { isChild: () => false },
  })
  Object.assign(services.agentSessions as object, { complete })
  return complete
}

beforeEach(() => registered.clear())

describe('ext.agentComplete', () => {
  it('answers only the built-in skills extension, not another extension holding the capability', async () => {
    const asMarketplace = wire(null)
    expect(await registered.get('ext.agentComplete')?.handler({}, ctx)).toEqual({
      ok: false,
      error: 'skills-only',
    })
    expect(asMarketplace).not.toHaveBeenCalled()
    registered.clear()
    const asAgent = wire('agent')
    expect(await registered.get('ext.agentComplete')?.handler({}, ctx)).toMatchObject({
      error: 'skills-only',
    })
    expect(asAgent).not.toHaveBeenCalled()
  })

  it('passes the call of the skills extension through', async () => {
    const complete = wire('skills')
    expect(await registered.get('ext.agentComplete')?.handler({ system: 's' }, ctx)).toEqual({
      ok: true,
      text: 'answer',
    })
    expect(complete).toHaveBeenCalledWith({ system: 's' })
  })
})
