import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { setAgentPlugins, writeClaudePlugin } from '../terminal/shellIntegration'
import {
  MANAGER_SKILL_NAME,
  managerAgentKind,
  managerArgv,
  usableSkillFolders,
  writeManagerClaudePlugin,
  writeManagerCodexContext,
} from './managerAgent'

let dir = ''

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

function skill(root: string, name: string): string {
  const folder = join(root, name)
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'SKILL.md'), `---\nname: ${name}\n---\n`)
  return folder
}

const opts = { claudePluginDir: '/tmp/p', codexContextFile: '/tmp/c.md', resume: null }

describe('managerArgv', () => {
  it('MGR-C28 gives claude the manager plugin dir, keeping the preset args after it', () => {
    expect(managerArgv(['/usr/bin/claude', '--model', 'opus'], opts)).toEqual([
      '/usr/bin/claude',
      '--plugin-dir',
      '/tmp/p',
      '--model',
      'opus',
    ])
  })

  it('MGR-C28 gives codex the hook args that load the manager context', () => {
    const argv = managerArgv(['codex', 'fix it'], opts)
    expect(argv[0]).toBe('codex')
    expect(argv).toContain('--no-daemon')
    expect(argv.join(' ')).toContain('/tmp/c.md')
    expect(argv.at(-1)).toBe('fix it')
  })

  it('leaves other programs untouched', () => {
    expect(managerArgv(['aider', '--yes'], opts)).toEqual(['aider', '--yes'])
  })

  it('MGR-C33 adds the saved session to resume, only for the same agent', () => {
    const resume = { agent: 'claude' as const, id: 'abc-123' }
    expect(managerArgv(['claude'], { ...opts, resume })).toEqual([
      'claude',
      '--plugin-dir',
      '/tmp/p',
      '--resume',
      'abc-123',
    ])
    expect(managerArgv(['aider'], { ...opts, resume })).toEqual(['aider'])
    const codex = managerArgv(['codex'], { ...opts, resume: { agent: 'codex', id: 'x1' } })
    expect(codex.slice(-2)).toEqual(['resume', 'x1'])
    expect(managerArgv(['codex'], { ...opts, resume })).not.toContain('--resume')
  })
})

describe('managerAgentKind', () => {
  it('knows claude and codex by program name', () => {
    expect(managerAgentKind('/home/u/.local/bin/claude')).toBe('claude')
    expect(managerAgentKind('codex')).toBe('codex')
    expect(managerAgentKind('claude-wrapper')).toBeNull()
  })
})

describe('manager plugin', () => {
  it('MGR-C28 holds the manager skill, the picked skills and the hooks; MGR-C36 skips a folder without SKILL.md', () => {
    dir = mkdtempSync(join(tmpdir(), 'ostia-mgr-plugin-'))
    const review = skill(join(dir, 'user-skills'), 'review')
    const noSkill = join(dir, 'user-skills', 'empty')
    mkdirSync(noSkill, { recursive: true })
    const plugin = join(dir, 'plugin')
    writeManagerClaudePlugin(plugin, [review, noSkill, join(dir, 'missing')])

    expect(readFileSync(join(plugin, 'skills', MANAGER_SKILL_NAME, 'SKILL.md'), 'utf8')).toContain(
      'name: ostia-manager',
    )
    expect(readlinkSync(join(plugin, 'skills', 'review'))).toBe(review)
    expect(existsSync(join(plugin, 'skills', 'empty'))).toBe(false)
    expect(existsSync(join(plugin, 'skills', 'ostia'))).toBe(false)
    const hooks = JSON.parse(readFileSync(join(plugin, 'hooks', 'hooks.json'), 'utf8'))
    expect(JSON.stringify(hooks)).toContain('resume-token claude -')
    const manifest = JSON.parse(readFileSync(join(plugin, '.claude-plugin', 'plugin.json'), 'utf8'))
    expect(manifest.name).toBe(MANAGER_SKILL_NAME)
  })

  it('MGR-C28 rewrites the plugin so a skill the human removed is gone', () => {
    dir = mkdtempSync(join(tmpdir(), 'ostia-mgr-plugin-'))
    const review = skill(dir, 'review')
    const plugin = join(dir, 'plugin')
    writeManagerClaudePlugin(plugin, [review])
    writeManagerClaudePlugin(plugin, [])
    expect(existsSync(join(plugin, 'skills', 'review'))).toBe(false)
  })

  it('never carries extension skills or hooks, even while the worker plugin has them', () => {
    dir = mkdtempSync(join(tmpdir(), 'ostia-mgr-plugin-'))
    setAgentPlugins({
      skills: [
        {
          id: 'kit-review',
          description: 'd',
          files: [{ name: 'SKILL.md', data: Buffer.from('x') }],
        },
      ],
      hooks: [{ extId: 'kit', event: 'SessionStart', command: 'on-hook' }],
    })
    const plugin = join(dir, 'plugin')
    writeManagerClaudePlugin(plugin, [])
    expect(existsSync(join(plugin, 'skills', 'kit-review'))).toBe(false)
    expect(readFileSync(join(plugin, 'hooks', 'hooks.json'), 'utf8')).not.toContain('agent-hook')
    const context = writeManagerCodexContext(join(dir, 'codex'), [])
    expect(managerArgv(['codex'], { ...opts, codexContextFile: context }).join(' ')).not.toContain(
      'agent-hook',
    )
    expect(readFileSync(context, 'utf8')).not.toContain('kit-review')
  })

  it('MGR-C28 the worker plugin never carries the manager skill', () => {
    dir = mkdtempSync(join(tmpdir(), 'ostia-worker-plugin-'))
    writeClaudePlugin(dir)
    expect(existsSync(join(dir, 'skills', MANAGER_SKILL_NAME))).toBe(false)
    expect(readFileSync(join(dir, 'skills', 'ostia', 'SKILL.md'), 'utf8')).not.toContain(
      'manager spawn',
    )
  })

  it('MGR-C28 the codex context names the manager guide and the picked skills', () => {
    dir = mkdtempSync(join(tmpdir(), 'ostia-mgr-codex-'))
    const review = skill(dir, 'review')
    const context = readFileSync(writeManagerCodexContext(join(dir, 'codex'), [review]), 'utf8')
    expect(context).toContain(join(dir, 'codex', 'SKILL.md'))
    expect(context).toContain(join(review, 'SKILL.md'))
  })

  it('MGR-C36 skips a picked skill whose name clashes with one already taken', () => {
    dir = mkdtempSync(join(tmpdir(), 'ostia-mgr-clash-'))
    const a = skill(join(dir, 'a'), 'review')
    const b = skill(join(dir, 'b'), 'review')
    const clash = skill(dir, MANAGER_SKILL_NAME)
    expect(MANAGER_SKILL_NAME).toBe('ostia-manager')
    expect(usableSkillFolders([a, b, clash])).toEqual([a])
  })
})
