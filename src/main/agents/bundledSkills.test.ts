import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'
import { skillDirective } from '@aurigax-ai/ostia-extension-sdk/contract/agentPlugins'
import { skillFrontmatter } from '@aurigax-ai/ostia-extension-sdk/manifest/agentSkills'
import { describe, expect, it } from 'vitest'
import { findNoun, USAGE_TABLE } from '../../cli/common/usageTable'
import { type BundledSkillFile, CORE_SKILL_FILES, MANAGER_SKILL_FILES } from './bundledSkills'

const ROOT = join(__dirname, '..', '..', '..')
const EXTENSIONS = join(ROOT, 'src', 'extensions')
const SKILL_BODY_MAX_LINES = 500
const DESCRIPTION_MAX = 1024
const CORE_SKILL_MAX_CHARS = 17_700
const CONTENTS_FROM_LINES = 100
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/

interface Manifest {
  id: string
  contributes?: {
    verb?: string
    commands?: { id: string; usage?: string; stdin?: true }[]
    agentSkills?: { name: string; path: string; files?: string[] }[]
  }
}

interface SkillUnderTest {
  label: string
  files: readonly BundledSkillFile[]
  own?: Manifest
}

function manifests(): Manifest[] {
  return readdirSync(EXTENSIONS)
    .map((dir) => join(EXTENSIONS, dir, 'ostia.json'))
    .filter((file) => existsSync(file))
    .map((file) => JSON.parse(readFileSync(file, 'utf8')) as Manifest)
}

function marketplaceIds(): string[] {
  const listing = JSON.parse(
    readFileSync(join(ROOT, 'marketplace', 'ostia-marketplace.json'), 'utf8'),
  ) as { extensions: string[]; unlisted: { path: string }[] }
  return [...listing.extensions, ...listing.unlisted.map((entry) => entry.path)].map(
    (path) => path.split('/').pop() ?? path,
  )
}

function extensionSkills(): SkillUnderTest[] {
  return manifests().flatMap((manifest) =>
    (manifest.contributes?.agentSkills ?? []).map((skill) => {
      const dir = join(EXTENSIONS, manifest.id, skill.path)
      const names = ['SKILL.md', ...(skill.files ?? [])]
      return {
        label: `${manifest.id}/${skill.name}`,
        own: manifest,
        files: names.map((path) => ({ path, text: readFileSync(join(dir, path), 'utf8') })),
      }
    }),
  )
}

const SKILLS: SkillUnderTest[] = [
  { label: 'ostia', files: CORE_SKILL_FILES },
  { label: 'ostia-manager', files: MANAGER_SKILL_FILES },
  ...extensionSkills(),
]

function frontmatter(text: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text)
  const fields: Record<string, string> = {}
  for (const line of match?.[1].split('\n') ?? []) {
    const at = line.indexOf(': ')
    if (at > 0) fields[line.slice(0, at)] = line.slice(at + 2)
  }
  return fields
}

function body(text: string): string {
  return text.replace(/^---\n[\s\S]*?\n---\n/, '')
}

function entry(skill: SkillUnderTest): BundledSkillFile {
  const found = skill.files.find((file) => file.path === 'SKILL.md')
  if (!found) throw new Error(`${skill.label} has no SKILL.md`)
  return found
}

function links(text: string): string[] {
  return [...text.matchAll(/\]\(([^)#\s]+\.md)\)/g)].map((m) => m[1])
}

function extensionCommands(): Map<string, Set<string>> {
  const builtIn = new Set(marketplaceIds())
  return new Map(
    manifests()
      .filter((manifest) => !builtIn.has(manifest.id))
      .map((manifest) => [
        manifest.id,
        new Set((manifest.contributes?.commands ?? []).map((command) => command.id)),
      ]),
  )
}

function commandsShown(text: string): [string, string | undefined][] {
  return [...text.matchAll(/(?<![\w/.-])ostia ([a-z][a-z-]*)(?: ([a-z][a-z-]*))?/g)].map((m) => [
    m[1],
    m[2],
  ])
}

const HUMAN_MANAGES_TOKENS = [
  'token create',
  'token update',
  'token show',
  'token list',
  'token revoke',
]
const HUMAN_INSTALLS_POLKIT_ACTION = ['polkit install']
const HUMAN_IMPORTS_CMUX_SESSION = ['cmux import']
const ADMIN_ONLY_COMMANDS = new Set([
  ...HUMAN_MANAGES_TOKENS,
  ...HUMAN_INSTALLS_POLKIT_ACTION,
  ...HUMAN_IMPORTS_CMUX_SESSION,
])
const EXTENSIONS_FOR_THE_HUMAN_NO_AGENT_SKILL_COVERS = new Set([
  'assistant',
  'handoff',
  'keeper',
  'model-runtime',
  'skills',
  'ssh',
  'trellis',
])

interface CliSurface {
  label: string
  noun: string
  verb?: string
  args?: string
}

function surface(noun: string, verb: string | undefined, args: string | undefined): CliSurface {
  return { label: ['ostia', noun, verb].filter(Boolean).join(' '), noun, verb, args }
}

function cliSurfaces(): CliSurface[] {
  return USAGE_TABLE.filter((usage) => usage.audience !== 'plumbing').flatMap((usage) => {
    const verbs = (usage.verbs ?? []).filter((verb) => !verb.hidden)
    if (verbs.length === 0) return [surface(usage.noun, undefined, usage.args)]
    return verbs.map((verb) => surface(usage.noun, verb.verb, verb.args))
  })
}

function extensionSurfaces(): CliSurface[] {
  return manifests()
    .filter((manifest) => !EXTENSIONS_FOR_THE_HUMAN_NO_AGENT_SKILL_COVERS.has(manifest.id))
    .flatMap((manifest) =>
      (manifest.contributes?.commands ?? [])
        .filter((command) => !command.stdin)
        .map((command) =>
          surface(manifest.contributes?.verb ?? manifest.id, command.id, command.usage),
        ),
    )
}

function flagsOf(args: string | undefined): string[] {
  return [...new Set(args?.match(/(?<![\w-])--?[a-zA-Z][\w-]*/g) ?? [])]
}

function mentions(text: string, shown: CliSurface): boolean {
  const verb = shown.verb ? ` ${shown.verb}` : ''
  const direct = new RegExp(`ostia ${shown.noun}${verb}(?![\\w-])`)
  const alternate = new RegExp(
    `ostia ${shown.noun} [^\\n]*\\| (?:${shown.noun} )?${shown.verb}(?![\\w-])`,
  )
  return direct.test(text) || (shown.verb !== undefined && alternate.test(text))
}

function showsFlag(text: string, flag: string): boolean {
  return new RegExp(`(?<![\\w-])${flag}(?![\\w-])`).test(text)
}

describe('bundled agent skills cover the CLI', () => {
  const texts = SKILLS.flatMap((skill) => skill.files).map((file) => file.text)
  const surfaces = [...cliSurfaces(), ...extensionSurfaces()].filter(
    (shown) => !ADMIN_ONLY_COMMANDS.has(shown.label.replace(/^ostia /, '')),
  )

  it.each(surfaces)('$label is shown with every flag it takes', (shown) => {
    const where = texts.filter((text) => mentions(text, shown))
    expect(where.length, `${shown.label} is in no skill`).toBeGreaterThan(0)
    for (const flag of flagsOf(shown.args)) {
      expect(
        where.some((text) => showsFlag(text, flag)),
        `${shown.label} ${flag} is in no skill`,
      ).toBe(true)
    }
  })
})

describe('bundled agent skills', () => {
  it.each(SKILLS)('$label has a valid name and a third-person description', (skill) => {
    const fields = frontmatter(entry(skill).text)
    expect(fields.name, skill.label).toMatch(NAME)
    expect(fields.name.length).toBeLessThanOrEqual(64)
    expect(fields.name).not.toMatch(/anthropic|claude/)
    const description = fields.description ?? ''
    expect(description.length, skill.label).toBeGreaterThan(0)
    expect(description.length, skill.label).toBeLessThanOrEqual(DESCRIPTION_MAX)
    expect(description, skill.label).not.toMatch(/\b(you|your|I|my|we)\b/i)
    expect(description.split(' ')[0], skill.label).toMatch(/^[A-Z][a-z]+s$/)
    expect(description, skill.label).toMatch(/\bUse when\b/)
  })

  it.each(SKILLS)(
    '$label passes the extension skill rules: name and description only, no injection',
    (skill) => {
      const { text } = entry(skill)
      expect(skillFrontmatter(text), skill.label).toMatchObject({ ok: true })
      expect(skillDirective(text), skill.label).toBeNull()
    },
  )

  it.each(SKILLS)('$label keeps SKILL.md within 500 lines', (skill) => {
    expect(body(entry(skill).text).split('\n').length).toBeLessThanOrEqual(SKILL_BODY_MAX_LINES)
  })

  it('keeps the core SKILL.md within the size it had after #1191', () => {
    expect(entry({ label: 'ostia', files: CORE_SKILL_FILES }).text.length).toBeLessThanOrEqual(
      CORE_SKILL_MAX_CHARS,
    )
  })

  it.each(SKILLS)('$label links only files it ships, one level deep', (skill) => {
    const paths = new Set(skill.files.map((file) => file.path))
    const linked = links(entry(skill).text).map((link) => normalize(link))
    for (const link of linked) expect(paths, `${skill.label}: ${link}`).toContain(link)
    for (const file of skill.files.filter((f) => f.path !== 'SKILL.md')) {
      expect(linked, `${skill.label}: ${file.path} is linked from SKILL.md`).toContain(file.path)
      expect(links(file.text), `${skill.label}: ${file.path} links further`).toEqual([])
      expect(dirname(file.path).split('/').length, file.path).toBeLessThanOrEqual(1)
      if (file.text.split('\n').length > CONTENTS_FROM_LINES) {
        expect(file.text, `${skill.label}: ${file.path} needs a contents list`).toContain(
          '## Contents',
        )
      }
    }
  })

  it.each(SKILLS)('$label shows only ostia commands that exist', (skill) => {
    const extensions = extensionCommands()
    if (skill.own) {
      const own = new Set((skill.own.contributes?.commands ?? []).map((command) => command.id))
      extensions.set(skill.own.id, own)
      if (skill.own.contributes?.verb) extensions.set(skill.own.contributes.verb, own)
    }
    for (const file of skill.files) {
      for (const [noun, verb] of commandsShown(file.text)) {
        const where = `${skill.label} ${file.path}: ostia ${noun} ${verb ?? ''}`
        const core = findNoun(noun)
        if (core) {
          if (core.verbs && verb) {
            expect(
              core.verbs.map((v) => v.verb),
              where,
            ).toContain(verb)
          }
          continue
        }
        expect(extensions.has(noun), where).toBe(true)
        if (verb) expect([...(extensions.get(noun) ?? [])], where).toContain(verb)
      }
    }
  })

  it('names no marketplace extension in the core skill', () => {
    const text = CORE_SKILL_FILES.map((file) => file.text).join('\n')
    for (const id of ['trellis', 'keeper', 'model-runtime', ...marketplaceIds()]) {
      expect(text, id).not.toMatch(new RegExp(`\\b${id}\\b`, 'i'))
    }
  })

  it('ships every markdown file in its folder', () => {
    for (const [folder, files] of [
      ['ostia', CORE_SKILL_FILES],
      ['ostia-manager', MANAGER_SKILL_FILES],
    ] as const) {
      const dir = join(__dirname, 'skills', folder)
      const onDisk = readdirSync(dir, { recursive: true, encoding: 'utf8' })
        .filter((path) => path.endsWith('.md'))
        .sort()
      expect(onDisk).toEqual(files.map((file) => file.path).sort())
    }
  })
})
