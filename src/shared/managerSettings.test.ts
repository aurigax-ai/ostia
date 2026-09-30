import { describe, expect, it } from 'vitest'
import { DEFAULT_MANAGER_SETTINGS, managerAgents, parseManagerSettings } from './managerSettings'

describe('parseManagerSettings', () => {
  it('MGR-C16 keeps valid presets and drops bad names, empty argv and non-strings', () => {
    const parsed = parseManagerSettings({
      agents: { aider: ['aider', '--yes'], 'bad name': ['x'], empty: [], num: [1], blank: [''] },
    })
    expect(parsed.agents).toEqual({ aider: ['aider', '--yes'] })
  })

  it('MGR-C16 falls back to defaults without a manager section', () => {
    expect(parseManagerSettings(undefined)).toEqual(DEFAULT_MANAGER_SETTINGS)
    expect(parseManagerSettings(['x'])).toEqual(DEFAULT_MANAGER_SETTINGS)
  })

  it('MGR-C28 keeps absolute skill folders only, without duplicates or ..', () => {
    const parsed = parseManagerSettings({
      skills: ['/home/u/skills/a', 'rel/b', '/home/u/../etc', '/home/u/skills/a', 3],
    })
    expect(parsed.skills).toEqual(['/home/u/skills/a'])
  })

  it('MGR-C30 turns typing into panes on only for a literal true', () => {
    expect(parseManagerSettings({ allowInput: true }).allowInput).toBe(true)
    expect(parseManagerSettings({ allowInput: 'yes' }).allowInput).toBe(false)
  })

  it('MGR-C29 clamps limits and falls back to defaults for non-numbers', () => {
    const parsed = parseManagerSettings({
      limits: { maxWorkers: 999, spawnsPer10Min: -3, busPerMinute: 'x' },
    })
    expect(parsed.limits).toEqual({ maxWorkers: 64, spawnsPer10Min: 0, busPerMinute: 60 })
  })
})

describe('managerAgents', () => {
  it('MGR-C16 merges presets over the built-in claude and codex', () => {
    const agents = managerAgents(
      parseManagerSettings({ agents: { claude: ['claude', '--model', 'opus'], aider: ['aider'] } }),
    )
    expect(agents).toEqual({
      claude: ['claude', '--model', 'opus'],
      codex: ['codex'],
      aider: ['aider'],
    })
  })
})
