import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (name: string): string => readFileSync(join(__dirname, name), 'utf8')

describe('what an agent can reach', () => {
  const manifest = JSON.parse(read('ostia.json')) as {
    contributes: { commands: { id: string }[]; agentHooks: { event: string; command: string }[] }
  }

  it('is only open, on-session and on-prompt, and the hooks only call the last two', () => {
    expect(manifest.contributes.commands.map((c) => c.id).sort()).toEqual([
      'on-prompt',
      'on-session',
      'open',
    ])
    expect(manifest.contributes.agentHooks).toEqual([
      { event: 'SessionStart', command: 'on-session' },
      { event: 'UserPromptSubmit', command: 'on-prompt' },
    ])
  })

  it('registers exactly those commands, so approve, retire, find-rules and the rest stay panel-only', () => {
    const main = read('main.ts')
    const block = /const handlers: Record<string, CommandHandler> = \{([\s\S]*?)\n {2}\}/.exec(
      main,
    )?.[1]
    const registered = [...(block ?? '').matchAll(/^\s{4}'?([a-z-]+)'?:/gm)].map((m) => m[1])
    expect(registered).toEqual(['open', 'on-session', 'on-prompt'])
    for (const panelOnly of ['approve', 'resolve', 'find-rules', 'save', 'forget-signals']) {
      expect(registered).not.toContain(panelOnly)
    }
  })

  it('never lets the hook commands write a rule or change a state', () => {
    const capture = read('capture.ts')
    expect(capture).not.toMatch(/store\.|RulesStore/)
  })
})
