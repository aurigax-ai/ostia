import { NO_AGENT_PLUGINS } from '@aurigax-ai/ostia-extension-sdk/manifest/agentSkills'
import { describe, expect, it, vi } from 'vitest'

const hooks = vi.hoisted(() => ({ claude: 'a', mod: 'm', codex: 'c' }))

vi.mock('./claudeIntegration', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./claudeIntegration')>()),
  claudeHookSettings: () => ({ hooks: { Probe: [hooks.claude] } }),
  get CLAUDE_MOD_SOURCE() {
    return hooks.mod
  },
}))
vi.mock('./codexIntegration', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./codexIntegration')>()),
  codexHookArgs: () => ['--probe', hooks.codex],
}))

const { agentPluginDigest } = await import('./agentPlugin')

describe('agentPluginDigest', () => {
  it('changes with the generated Claude hooks, the mod source and the Codex hook args', () => {
    const base = agentPluginDigest(NO_AGENT_PLUGINS, [])
    expect(agentPluginDigest(NO_AGENT_PLUGINS, [])).toBe(base)
    const seen = new Set([base])
    for (const key of ['claude', 'mod', 'codex'] as const) {
      hooks[key] = `${hooks[key]}2`
      seen.add(agentPluginDigest(NO_AGENT_PLUGINS, []))
    }
    expect(seen.size).toBe(4)
  })
})
