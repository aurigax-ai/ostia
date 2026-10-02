import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AGENT_SKILL_FILE_MAX_BYTES } from '../shared/agentPlugins'
import {
  agentPluginContent,
  agentSkillProblems,
  loadAgentSkill,
  skillFrontmatter,
  withSkillName,
} from './agentSkills'
import { parseManifest } from './extensionManifest'

const SKILL = '---\nname: review\ndescription: Use when reviewing.\n---\n\n# Review\n'

describe('skillFrontmatter', () => {
  it('reads name and description from the leading YAML block', () => {
    expect(skillFrontmatter(SKILL)).toEqual({
      name: 'review',
      description: 'Use when reviewing.',
    })
    expect(skillFrontmatter('---\nname: "a"\ndescription: \'b c\'\n---\n')).toEqual({
      name: 'a',
      description: 'b c',
    })
  })

  it('needs both fields inside a closed block at the top', () => {
    expect(skillFrontmatter('# Review\n')).toBeNull()
    expect(skillFrontmatter('---\nname: a\n')).toBeNull()
    expect(skillFrontmatter('---\nname: a\n---\n')).toBeNull()
  })
})

describe('withSkillName', () => {
  it('renames only the frontmatter name, keeping CRLF line ends', () => {
    expect(withSkillName('---\r\nname: a\r\ndescription: b\r\n---\r\nname: body\r\n', 'x-a')).toBe(
      '---\r\nname: x-a\r\ndescription: b\r\n---\r\nname: body\r\n',
    )
  })
})

describe('loadAgentSkill', () => {
  let dir: string
  let ext: string
  let skillDir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pine-agent-skill-'))
    ext = join(dir, 'kit')
    skillDir = join(ext, 'skills', 'review')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), SKILL)
    writeFileSync(join(skillDir, 'checklist.md'), '- tests\n')
    writeFileSync(join(skillDir, 'unlisted.md'), 'not declared\n')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const skill = (files: string[] = ['checklist.md'], path = 'skills/review') => ({
    name: 'review',
    path,
    files,
  })

  it('reads SKILL.md and the declared files, and nothing else in the folder', () => {
    const res = loadAgentSkill(ext, 'kit', skill())
    if (!res.ok) throw new Error(res.error)
    expect(res.skill.id).toBe('kit-review')
    expect(res.skill.description).toBe('Use when reviewing.')
    expect(res.skill.files.map((f) => f.name)).toEqual(['SKILL.md', 'checklist.md'])
    expect(res.skill.files[0]?.data.toString()).toBe(
      '---\nname: kit-review\ndescription: Use when reviewing.\n---\n\n# Review\n',
    )
  })

  it('refuses a SKILL.md whose name is not the declared skill name', () => {
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: pine\ndescription: x\n---\n')
    expect(loadAgentSkill(ext, 'kit', skill())).toEqual({
      ok: false,
      error: "SKILL.md: name must be 'review'",
    })
  })

  it('refuses a missing declared file', () => {
    expect(loadAgentSkill(ext, 'kit', skill(['gone.md']))).toEqual({
      ok: false,
      error: 'gone.md: missing',
    })
  })

  it('refuses a symlinked file, even to a file inside the extension', () => {
    symlinkSync(join(skillDir, 'unlisted.md'), join(skillDir, 'link.md'))
    expect(loadAgentSkill(ext, 'kit', skill(['link.md']))).toEqual({
      ok: false,
      error: 'link.md: symlink refused',
    })
  })

  it('refuses a skill folder reached through a symlink', () => {
    symlinkSync(skillDir, join(ext, 'skills', 'alias'))
    const res = loadAgentSkill(ext, 'kit', skill([], 'skills/alias'))
    expect(res).toEqual({ ok: false, error: 'SKILL.md: symlink refused' })
  })

  it('refuses a file outside the extension through a symlinked folder', () => {
    const outside = join(dir, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'SKILL.md'), SKILL)
    symlinkSync(outside, join(ext, 'skills', 'out'))
    expect(loadAgentSkill(ext, 'kit', skill([], 'skills/out')).ok).toBe(false)
  })

  it('refuses binary and oversized files', () => {
    writeFileSync(join(skillDir, 'checklist.md'), Buffer.from([0x61, 0x00, 0x62]))
    expect(loadAgentSkill(ext, 'kit', skill())).toEqual({
      ok: false,
      error: 'checklist.md: not plain text',
    })
    writeFileSync(join(skillDir, 'checklist.md'), 'a'.repeat(AGENT_SKILL_FILE_MAX_BYTES + 1))
    expect(loadAgentSkill(ext, 'kit', skill())).toEqual({
      ok: false,
      error: `checklist.md: larger than ${AGENT_SKILL_FILE_MAX_BYTES} bytes`,
    })
  })

  it('collects only declared skills and reports a broken one without dropping the others', () => {
    mkdirSync(join(ext, 'skills', 'broken'))
    writeFileSync(join(ext, 'skills', 'broken', 'SKILL.md'), 'no frontmatter\n')
    const problems: string[] = []
    const content = agentPluginContent(
      [
        {
          extId: 'kit',
          dir: ext,
          skills: [skill(), { name: 'broken', path: 'skills/broken', files: [] }],
          hooks: [{ event: 'Stop', command: 'on-hook' }],
        },
      ],
      (extId, problem) => problems.push(`${extId}: ${problem}`),
    )
    expect(content.skills.map((s) => s.id)).toEqual(['kit-review'])
    expect(content.hooks).toEqual([{ extId: 'kit', event: 'Stop', command: 'on-hook' }])
    expect(problems).toEqual([
      "kit: agent skill 'broken': SKILL.md: needs frontmatter with name and description",
    ])
  })

  it('lists skill problems for pine-extension validate', () => {
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: other\ndescription: x\n---\n')
    const res = parseManifest(
      {
        id: 'kit',
        name: 'Kit',
        version: '1.0.0',
        api: '1.0',
        capabilities: ['agent-plugin'],
        contributes: { agentSkills: [skill()] },
      },
      ext,
    )
    if (!res.ok) throw new Error(res.error)
    expect(agentSkillProblems(ext, res.manifest)).toEqual([
      "agent skill 'review': SKILL.md: name must be 'review'",
    ])
  })
})

describe('the trellis extension', () => {
  const dir = join(__dirname, '..', 'extensions', 'trellis')
  const parsed = parseManifest(JSON.parse(readFileSync(join(dir, 'pine.json'), 'utf8')), dir)
  if (!parsed.ok) throw new Error(parsed.error)
  const manifest = parsed.manifest

  it('declares its card skill and a SessionStart hook under the agent-plugin capability', () => {
    expect(manifest.capabilities).toContain('agent-plugin')
    expect(manifest.contributes.agentSkills).toEqual([
      { name: 'card', path: 'skills/card', files: [] },
    ])
    expect(manifest.contributes.agentHooks).toEqual([
      { event: 'SessionStart', command: 'session-context' },
    ])
    expect(agentSkillProblems(dir, manifest)).toEqual([])
  })

  it('ships a skill folder that loads as trellis-card and teaches the card commands', () => {
    const [skill] = manifest.contributes.agentSkills ?? []
    if (!skill) throw new Error('no skill')
    const res = loadAgentSkill(dir, manifest.id, skill)
    if (!res.ok) throw new Error(res.error)
    expect(res.skill.id).toBe('trellis-card')
    expect(res.skill.files.map((f) => f.name)).toEqual(['SKILL.md'])
    const text = res.skill.files[0]?.data.toString() ?? ''
    expect(text.split('\n')[1]).toBe('name: trellis-card')
    for (const taught of [
      'trellis card show <ref>',
      'trellis card claim <ref>',
      'trellis card comment <ref> --body',
      'trellis card renew <ref>',
      'trellis card move <ref> <column>',
      'TRELLIS_AGENT',
      'stderr',
      '--body @notes.md',
      'trellis vault new',
      'trellis vault edit',
    ]) {
      expect(text, taught).toContain(taught)
    }
    expect(text).not.toMatch(/pine/i)
  })
})
