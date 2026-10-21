import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AGENT_SKILL_DESCRIPTION_MAX,
  AGENT_SKILL_FILE_MAX_BYTES,
  AGENT_SKILL_MAX_BYTES,
  skillDirective,
} from '../contract/agentPlugins'
import { PRODUCT_NAME } from '../contract/product'
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
    ['blank lines', '\nname: a\n\ndescription: b\n'],
    ['a colon and dashes inside the value', 'name: a\ndescription: b - c (d-1)'],
    ['a hash without a space before it', 'name: a\ndescription: b#c'],
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
    ['a list', 'name: a\ndescription:\n  - x', 4, 'indented lines'],
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

  it.each([
    ['allowed-tools', 'name: a\ndescription: b\nallowed-tools: Bash(*)'],
    ['allowed-tools with a list', 'name: a\ndescription: b\nallowed-tools:\n  - Bash'],
    ['model', 'name: a\ndescription: b\nmodel: opus'],
    ['hooks', 'name: a\ndescription: b\nhooks:\n  PreToolUse:\n    - command: x'],
    ['hooks with no value', 'name: a\ndescription: b\nhooks:'],
    ['disable-model-invocation', 'name: a\ndescription: b\ndisable-model-invocation: true'],
    ['disallowed-tools', 'name: a\ndescription: b\ndisallowed-tools: Read'],
    ['context', 'name: a\ndescription: b\ncontext: fork'],
    ['agent', 'name: a\ndescription: b\nagent: general-purpose'],
    ['shell', 'name: a\ndescription: b\nshell: bash'],
    ['paths', 'name: a\ndescription: b\npaths: src/**'],
    ['license', 'name: a\ndescription: b\nlicense: MIT'],
    ['a different case', 'name: a\ndescription: b\nAllowed-Tools: Bash(*)'],
    ['a key before name', 'allowed-tools: Bash(*)\nname: a\ndescription: b'],
  ])('refuses the key %s', (_label, lines) => {
    const res = skillFrontmatter(front(lines))
    expect(res).toMatchObject({ ok: false })
    if (res?.ok !== false) return
    expect(res.error).toContain('only name and description')
  })

  it.each([
    ['a lone carriage return', 'name: a\ndescription: b\rallowed-tools: Bash(*)'],
    ['a next line character', 'name: a\ndescription: b\u0085allowed-tools: Bash(*)'],
    ['a line separator', 'name: a\ndescription: b\u2028allowed-tools: Bash(*)'],
    ['a paragraph separator', 'name: a\ndescription: b\u2029allowed-tools: Bash(*)'],
    ['a vertical tab', 'name: a\ndescription: b\u000ballowed-tools: Bash(*)'],
  ])('refuses %s inside the frontmatter', (_label, lines) => {
    const res = skillFrontmatter(front(lines))
    expect(res).toMatchObject({ ok: false })
    if (res?.ok !== false) return
    expect(res.error).toContain('control characters')
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

describe('skillDirective', () => {
  it.each([
    ['a plain body', '# Review\n\nRun `ostia docs skill`.\n'],
    ['an exclamation mark in prose', 'Careful! Run it twice!\n'],
    ['a backtick span after a word', 'Use the `git` command.\n'],
    ['a fence with a language', '```sh\nls\n```\n'],
    ['a $ARGUMENTS placeholder', 'Review $ARGUMENTS and ${CLAUDE_SKILL_DIR}/checklist.md\n'],
    ['an exclamation mark then a space then a backtick', 'Done! `x`\n'],
    ['a dollar amount', 'It costs $5 and $ARGUMENTS stays text.\n'],
    ['a fence with a language and a placeholder', '```sh\necho $0\n```\n'],
  ])('accepts %s', (_label, text) => {
    expect(skillDirective(text)).toBeNull()
  })

  it.each([
    ['inline injection at the line start', '!`rm -rf ~`\n'],
    ['inline injection after text', '- PR diff: !`gh pr diff`\n'],
    ['inline injection glued to a word', 'KEY=!`id`\n'],
    ['inline injection in the frontmatter', '---\nname: a\ndescription: !`id`\n---\n'],
    ['a fenced block', '```!\nnode --version\n```\n'],
    ['a longer fence', '````!\nid\n````\n'],
    ['a fence with a space before the mark', '``` !\nid\n```\n'],
    ['a tilde fence', '~~~!\nid\n~~~\n'],
    ['an indented fence', '   ```!\nid\n```\n'],
    ['a fullwidth exclamation mark', '\uff01`id`\n'],
    ['a fullwidth backtick', '!\uff40id\uff40\n'],
    ['a modifier letter grave', '!\u02cbid`\n'],
    ['a reversed prime', '!\u2035id`\n'],
    ['a fullwidth fenced block', '\uff40\uff40\uff40!\nid\n'],
    ['CRLF line ends', 'text\r\n!`id`\r\n'],
    ['a lone carriage return', 'text\r!`id`\n'],
    ['a line separator', 'text\u2028!`id`\n'],
    ['an argument placeholder after the mark', 'Status: !$ARGUMENTS\n'],
    ['a positional placeholder after the mark', '!$0\n'],
    ['an indexed placeholder after the mark', '!$ARGUMENTS[0]\n'],
    ['a skill folder placeholder after the mark', '!${CLAUDE_SKILL_DIR}/run.sh\n'],
    ['a fence line made of a placeholder', '```$0\nid\n```\n'],
    ['a longer fence made of a placeholder', '````$ARGUMENTS\nid\n````\n'],
    ['a tilde fence made of a placeholder', '~~~ $1\nid\n~~~\n'],
    ['a fullwidth mark before a placeholder', '\uff01$ARGUMENTS\n'],
    ['a fullwidth dollar after the mark', '!\uff04ARGUMENTS\n'],
  ])('refuses %s', (_label, text) => {
    expect(skillDirective(text)).toContain('shell injection')
  })

  it('names the line', () => {
    expect(skillDirective('a\nb\nc !`id`\n')).toBe(
      'line 3: shell injection (!` or a ```! block) is not allowed',
    )
    expect(skillDirective('a\r\nb\rc\n!`id`')).toContain('line 4:')
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
    '\nname: a\n\ndescription: b\n',
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
    dir = mkdtempSync(join(tmpdir(), 'ostia-agent-skill-'))
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

  it('keeps the bare name of a built-in extension’s skill and refuses it for any other', () => {
    const bare = { ...skill(), bare: true }
    const builtin = loadAgentSkill(ext, 'kit', bare, true)
    if (!builtin.ok) throw new Error(builtin.error)
    expect(builtin.skill.id).toBe('review')
    expect(builtin.skill.files[0]?.data.toString()).toContain('name: review\n')
    expect(loadAgentSkill(ext, 'kit', bare)).toEqual({
      ok: false,
      error: 'only a built-in extension may use a bare skill name',
    })
  })

  it('refuses a bare skill that takes the product’s own skill name', () => {
    const own = { name: PRODUCT_NAME, path: 'skills/review', files: [], bare: true }
    expect(loadAgentSkill(ext, 'kit', own, true)).toEqual({
      ok: false,
      error: `'${PRODUCT_NAME}' is a reserved skill name`,
    })
  })

  it('reports a second skill with a taken id and keeps the first', () => {
    const problems: string[] = []
    const source = (extId: string) => ({
      extId,
      builtin: true,
      dir: ext,
      skills: [{ ...skill(), bare: true }],
      hooks: [],
    })
    const content = agentPluginContent([source('one'), source('two')], (id, problem) =>
      problems.push(`${id}: ${problem}`),
    )
    expect(content.skills.map((s) => s.id)).toEqual(['review'])
    expect(problems).toEqual(["two: agent skill 'review': 'review' is already taken"])
  })

  it('accepts a skill of exactly the total size and refuses one a byte over', () => {
    const names = ['f0.md', 'f1.md', 'f2.md', 'f3.md']
    const sizes = [
      AGENT_SKILL_FILE_MAX_BYTES,
      AGENT_SKILL_FILE_MAX_BYTES,
      AGENT_SKILL_FILE_MAX_BYTES,
    ]
    const rest = AGENT_SKILL_MAX_BYTES - Buffer.byteLength(SKILL) - sizes.reduce((a, b) => a + b, 0)
    names.forEach((name, i) => {
      writeFileSync(join(skillDir, name), 'a'.repeat(sizes[i] ?? rest))
    })
    expect(loadAgentSkill(ext, 'kit', skill(names)).ok).toBe(true)
    writeFileSync(join(skillDir, 'f3.md'), 'a'.repeat(rest + 1))
    expect(loadAgentSkill(ext, 'kit', skill(names))).toEqual({
      ok: false,
      error: `larger than ${AGENT_SKILL_MAX_BYTES} bytes in all`,
    })
  })

  it('accepts a description of exactly the longest length and refuses one a character over', () => {
    const entry = (description: string) =>
      `---\nname: review\ndescription: ${description}\n---\n\n# Review\n`
    writeFileSync(join(skillDir, 'SKILL.md'), entry('d'.repeat(AGENT_SKILL_DESCRIPTION_MAX)))
    expect(loadAgentSkill(ext, 'kit', skill()).ok).toBe(true)
    writeFileSync(join(skillDir, 'SKILL.md'), entry('d'.repeat(AGENT_SKILL_DESCRIPTION_MAX + 1)))
    expect(loadAgentSkill(ext, 'kit', skill())).toEqual({
      ok: false,
      error: `SKILL.md: description is longer than ${AGENT_SKILL_DESCRIPTION_MAX} characters`,
    })
  })

  it('refuses a SKILL.md whose name is not the declared skill name', () => {
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: ostia\ndescription: x\n---\n')
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

  it.each([
    ['allowed-tools', 'allowed-tools: Bash(*)'],
    ['model', 'model: opus'],
    ['hooks', 'hooks:\n  PreToolUse:\n    - command: id'],
  ])('refuses a SKILL.md that carries %s and names it', (key, extra) => {
    writeFileSync(join(skillDir, 'SKILL.md'), `---\nname: review\ndescription: x\n${extra}\n---\n`)
    const res = loadAgentSkill(ext, 'kit', skill())
    expect(res).toMatchObject({ ok: false })
    if (res.ok) return
    expect(res.error).toContain('SKILL.md: line 4:')
    expect(res.error).toContain(`'${key}'`)
    expect(res.error).toContain('only name and description')
  })

  it.each([
    ['inline injection', '# Review\n\nDiff: !`git diff`\n'],
    ['a fenced block', '# Review\n\n```!\ngit diff\n```\n'],
    ['a lookalike backtick', '# Review\n\nDiff: !\uff40git diff\uff40\n'],
  ])('refuses a SKILL.md body with %s', (_label, body) => {
    writeFileSync(join(skillDir, 'SKILL.md'), `${SKILL.slice(0, -'# Review\n'.length)}${body}`)
    const res = loadAgentSkill(ext, 'kit', skill())
    expect(res).toMatchObject({ ok: false })
    if (res.ok) return
    expect(res.error).toMatch(/^SKILL\.md: line \d+: shell injection/)
  })

  it('refuses a BOM-prefixed SKILL.md that carries an extra key', () => {
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '\uFEFF---\nname: review\ndescription: x\nallowed-tools: Bash(*)\n---\nBody\n',
    )
    const res = loadAgentSkill(ext, 'kit', skill())
    expect(res).toMatchObject({ ok: false })
    if (res.ok) return
    expect(res.error).toContain("'allowed-tools' is not allowed")
  })

  it('refuses a skill whose body builds the command from its arguments', () => {
    writeFileSync(join(skillDir, 'SKILL.md'), `${SKILL}\nStatus: !$ARGUMENTS\n`)
    const res = loadAgentSkill(ext, 'kit', skill())
    expect(res).toMatchObject({ ok: false })
    if (res.ok) return
    expect(res.error).toMatch(/^SKILL\.md: line \d+: shell injection/)
  })

  it('does not read a reference file for directives, only SKILL.md is rendered', () => {
    writeFileSync(join(skillDir, 'checklist.md'), 'Docs: !`id` runs a command\n')
    expect(loadAgentSkill(ext, 'kit', skill()).ok).toBe(true)
  })

  it('refuses the extension skill and keeps the rest when collecting', () => {
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: review\ndescription: x\nallowed-tools: Bash(*)\n---\n',
    )
    const problems: string[] = []
    const content = agentPluginContent(
      [{ extId: 'kit', dir: ext, skills: [skill()], hooks: [] }],
      (extId, problem) => problems.push(`${extId}: ${problem}`),
    )
    expect(content.skills).toEqual([])
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain("'allowed-tools' is not allowed")
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

  it('lists skill problems for ostia-extension validate', () => {
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: other\ndescription: x\n---\n')
    const res = parseManifest(
      {
        id: 'kit',
        name: 'Kit',
        version: '1.0.0',
        api: '7.0',
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
