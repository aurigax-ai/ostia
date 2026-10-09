import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { CHAT_TOOL_OUTPUT_MAX } from '../../shared/assist'
import {
  SKILLS_MAX,
  SKILL_DESCRIPTION_MAX,
  SKILL_FILE_MAX,
  SKILL_NAME,
  type SkillLoadResult,
  type SkillSummary,
} from '../../shared/chatTools'

export const SKILL_FILE = 'SKILL.md'

interface ParsedSkill {
  name: string
  description: string
  body: string
}

export function parseSkillText(text: string, fallbackName: string): ParsedSkill | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!match) return null
  let meta: unknown
  try {
    meta = parseYaml(match[1], { maxAliasCount: 0 })
  } catch {
    return null
  }
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return null
  const fields = meta as Record<string, unknown>
  const name = typeof fields.name === 'string' ? fields.name.trim() : fallbackName
  const description =
    typeof fields.description === 'string'
      ? fields.description.replace(/\s+/g, ' ').trim().slice(0, SKILL_DESCRIPTION_MAX)
      : ''
  if (!SKILL_NAME.test(name) || !description) return null
  return { name, description, body: text.slice(match[0].length) }
}

function isRealDir(path: string): boolean {
  try {
    const info = lstatSync(path)
    return info.isDirectory() && !info.isSymbolicLink()
  } catch {
    return false
  }
}

function readSkillFile(dir: string): ParsedSkill | null {
  const file = join(dir, SKILL_FILE)
  try {
    const info = lstatSync(file)
    if (info.isSymbolicLink() || !info.isFile() || info.size > SKILL_FILE_MAX) return null
    return parseSkillText(readFileSync(file, 'utf8'), basename(dir))
  } catch {
    return null
  }
}

function skillDirs(folder: string): string[] {
  if (!isRealDir(folder)) return []
  try {
    if (lstatSync(join(folder, SKILL_FILE)).isFile()) return [folder]
  } catch {}
  try {
    return readdirSync(folder, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.isSymbolicLink())
      .map((d) => join(folder, d.name))
      .sort()
  } catch {
    return []
  }
}

interface FoundSkill extends ParsedSkill {
  path: string
}

function findSkills(folders: readonly string[]): FoundSkill[] {
  const out: FoundSkill[] = []
  for (const folder of folders) {
    for (const dir of skillDirs(folder)) {
      if (out.length === SKILLS_MAX) return out
      const skill = readSkillFile(dir)
      if (skill && !out.some((s) => s.name === skill.name)) {
        out.push({ ...skill, path: join(dir, SKILL_FILE) })
      }
    }
  }
  return out
}

export function listSkills(folders: readonly string[]): SkillSummary[] {
  return findSkills(folders).map(({ name, description, path }) => ({ name, description, path }))
}

export function loadSkill(folders: readonly string[], name: unknown): SkillLoadResult {
  if (typeof name !== 'string' || !SKILL_NAME.test(name)) return { ok: false, error: 'invalid' }
  const skill = findSkills(folders).find((s) => s.name === name)
  if (!skill) return { ok: false, error: 'unknown-skill' }
  return {
    ok: true,
    name: skill.name,
    path: skill.path,
    body: skill.body.slice(0, CHAT_TOOL_OUTPUT_MAX),
  }
}
