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

const front = (lines: string, tail = '') => `---\n${lines}\n---\n${tail}`
const NAME_DESC = 'name: a\ndescription: b'

describe('skillFrontmatter', () => {
  it('reads name and description from the leading YAML block', () => {
    expect(skillFrontmatter(SKILL)).toEqual({
      ok: true,
      name: 'review',
      description: 'Use when reviewing.',
    })
  })

  it.each([
    ['double quotes', 'name: "a"\ndescription: "b c"'],
    ['single quotes', "name: 'a'\ndescription: 'b c'"],
    ['blank lines and extra keys', '\nname: a\n\nlicense: MIT\ndescription: b\n'],
    ['a colon and dashes inside the value', 'name: a\ndescription: b - c (d-1)'],
    ['a hash without a space before it', 'name: a\ndescription: b#c'],
    ['an empty extra key', 'name: a\ndescription: b\nextra:'],
    ['CRLF line ends', 'name: a\r\ndescription: b\r'],
  ])('accepts %s', (_label, lines) => {
    expect(skillFrontmatter(front(lines))).toMatchObject({ ok: true })
  })

  it('strips a leading BOM and accepts a body with a rule line', () => {
    expect(skillFrontmatter(`\uFEFF${front(NAME_DESC, '\ntext\n\n---\n\nmore\n')}`)).toEqual({
      ok: true,
      name: 'a',
      description: 'b',
    })
  })

  it('needs both fields inside a closed block at the top', () => {
    expect(skillFrontmatter('# Review\n')).toBeNull()
    expect(skillFrontmatter('---\nname: a\n')).toBeNull()
    expect(skillFrontmatter('---\nname: a\n---\n')).toEqual({
      ok: false,
      error: 'needs a description',
    })
    expect(skillFrontmatter('---\ndescription: a\n---\n')).toEqual({
      ok: false,
      error: 'needs a name',
    })
  })

  it.each([
    ['a folded block scalar', 'name: a\ndescription: >', 3, 'block scalars'],
    ['a literal block scalar', 'name: a\ndescription: |', 3, 'block scalars'],
    ['a stripped folded scalar', 'name: a\ndescription: >-', 3, 'block scalars'],
    ['a stripped literal scalar', 'name: a\ndescription: |-', 3, 'block scalars'],
    ['a kept folded scalar', 'name: a\ndescription: >+', 3, 'block scalars'],
    ['a kept literal scalar', 'name: a\ndescription: |+', 3, 'block scalars'],
    ['a nested map', 'name: a\ndescription:\n  x: y', 4, 'indented lines'],
    ['a list', 'name: a\ndescription: b\nitems:\n  - x', 5, 'indented lines'],
    ['a stray indented line', 'name: a\n  description: b', 3, 'indented lines'],
    ['a flow map', 'name: a\ndescription: {x: y}', 3, 'flow collections'],
    ['a flow list', 'name: a\ndescription: [x]', 3, 'flow collections'],
    ['an anchor', 'name: a\ndescription: &x b', 3, 'anchors, aliases and tags'],
    ['an alias', 'name: a\ndescription: *x', 3, 'anchors, aliases and tags'],
    ['a tag', 'name: a\ndescription: !!str b', 3, 'anchors, aliases and tags'],
    ['a quoted key', '"name": a\ndescription: b', 2, 'quoted keys'],
    ['a space before the colon', 'name : a\ndescription: b', 2, 'space allowed before the colon'],
    ['a duplicate key', 'name: a\nname: b\ndescription: c', 3, "duplicate key 'name'"],
    ['an inline comment', 'name: a\ndescription: b # c', 3, "' #'"],
    ['a value that is a comment', 'name: a\ndescription: # c', 3, "' #'"],
    ['a comment line', '# c\nname: a\ndescription: b', 2, 'comments'],
    ['an unclosed quote', 'name: a\ndescription: "b', 3, 'matching pair'],
    ['a quote inside quotes', 'name: a\ndescription: "b"c"', 3, 'matching pair'],
    ['an escape inside quotes', 'name: a\ndescription: "b\\n"', 3, 'escapes'],
    ['a line without a colon', 'name: a\ndescription: b\nstray', 4, 'expected key: value'],
    ['no space after the colon', 'name:a\ndescription: b', 2, 'expected key: value'],
    ['a document end marker', 'name: a\ndescription: b\n...', 4, 'expected key: value'],
  ])('refuses %s', (_label, lines, line, reason) => {
    const res = skillFrontmatter(front(lines))
    expect(res).toMatchObject({ ok: false })
    if (res?.ok !== false) return
    expect(res.error).toContain(`line ${line}:`)
    expect(res.error).toContain(reason)
  })

  it('refuses a second frontmatter block after the closing fence', () => {
    expect(skillFrontmatter(front(NAME_DESC, '\n---\nname: x\n---\n'))).toEqual({
      ok: false,
      error: 'line 5: a second frontmatter block is not supported',
    })
  })

  it.each([
    ['name', 'name: ""\ndescription: b', 'name is empty'],
    ['name', "name: ''\ndescription: b", 'name is empty'],
    ['name', 'name:\ndescription: b', 'name is empty'],
    ['description', 'name: a\ndescription: ""', 'description is empty'],
    ['description', 'name: a\ndescription:', 'description is empty'],
  ])('refuses an empty %s', (_field, lines, error) => {
    expect(skillFrontmatter(front(lines))).toEqual({ ok: false, error })
  })
})

describe('withSkillName', () => {
  it('renames only the frontmatter name, keeping CRLF line ends', () => {
    expect(withSkillName('---\r\nname: a\r\ndescription: b\r\n---\r\nname: body\r\n', 'x-a')).toBe(
      '---\r\nname: x-a\r\ndescription: b\r\n---\r\nname: body\r\n',
    )
  })

  it.each([
    'name: a\ndescription: b',
    'description: b\nname: a',
    'name: "a"\ndescription: b',
    "name: 'a'\ndescription: b",
    '\nname: a\n\ndescription: b\nlicense: MIT',
    'name:   a  \ndescription: b',
  ])('leaves exactly one name line, x-a, for every accepted frontmatter (%j)', (lines) => {
    const text = front(lines, 'name: body\n')
    expect(skillFrontmatter(text)).toMatchObject({ ok: true, name: 'a' })
    const out = withSkillName(text, 'x-a').split('\n')
    expect(out.filter((line) => line.startsWith('name:'))).toEqual(['name: x-a', 'name: body'])
    expect(out.indexOf('name: x-a')).toBeLessThan(out.indexOf('---', 1))
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

  it('refuses a SKILL.md with a YAML form the parser does not read, naming the line', () => {
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: review\ndescription: >\n  x\n---\n')
    expect(loadAgentSkill(ext, 'kit', skill())).toEqual({
      ok: false,
      error: 'SKILL.md: line 3: block scalars are not supported',
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
