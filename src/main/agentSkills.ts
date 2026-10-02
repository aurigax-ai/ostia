import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import {
  AGENT_SKILL_DESCRIPTION_MAX,
  AGENT_SKILL_ENTRY,
  AGENT_SKILL_FILE_MAX_BYTES,
  AGENT_SKILL_MAX_BYTES,
  type AgentHookContribution,
  type AgentHookEvent,
  type AgentSkillContribution,
  agentSkillId,
} from '../shared/agentPlugins'
import type { ExtensionManifest } from '../shared/extensions'
import { readConfined } from './confinedRead'

export interface AgentPluginSource {
  extId: string
  dir: string
  skills: AgentSkillContribution[]
  hooks: AgentHookContribution[]
}

export interface AgentSkillFile {
  name: string
  data: Buffer
}

export interface LoadedAgentSkill {
  id: string
  description: string
  files: AgentSkillFile[]
}

export interface ExtensionAgentHook {
  extId: string
  event: AgentHookEvent
  command: string
}

export interface AgentPluginContent {
  skills: LoadedAgentSkill[]
  hooks: ExtensionAgentHook[]
}

export const NO_AGENT_PLUGINS: AgentPluginContent = { skills: [], hooks: [] }

export type AgentSkillResult = { ok: true; skill: LoadedAgentSkill } | { ok: false; error: string }

const utf8 = new TextDecoder('utf-8', { fatal: true })

function plainText(data: Buffer): string | null {
  if (data.includes(0)) return null
  try {
    return utf8.decode(data)
  } catch {
    return null
  }
}

const FIELD_LINE = /^([A-Za-z][A-Za-z0-9_-]*):(?: +(.*))?$/
const BLOCK_SCALAR = /^[>|][+-]?$/

export type SkillFrontmatter =
  | { ok: true; name: string; description: string }
  | { ok: false; error: string }

function closingFence(lines: readonly string[]): number {
  return lines.findIndex((line, i) => i > 0 && line.replace(/\r$/, '') === '---')
}

function refuse(line: number, reason: string): SkillFrontmatter {
  return { ok: false, error: `line ${line}: ${reason}` }
}

function valueProblem(raw: string): string | null {
  const value = raw.trim()
  if (BLOCK_SCALAR.test(value)) return 'block scalars are not supported'
  if (/^[{[]/.test(value)) return 'flow collections are not supported'
  if (/^[&*!]/.test(value)) return 'anchors, aliases and tags are not supported'
  if (/(^|\s)#/.test(raw)) return "' #' is ambiguous, remove the comment"
  const quote = value[0]
  if (quote === '"' || quote === "'") {
    const inner = value.slice(1, -1)
    if (value.length < 2 || !value.endsWith(quote) || inner.includes(quote)) {
      return 'a quoted value must be one matching pair of quotes'
    }
    if (inner.includes('\\')) return 'escapes inside quotes are not supported'
  }
  return null
}

function unquote(value: string): string {
  return /^["']/.test(value) ? value.slice(1, -1) : value
}

function keyProblem(line: string): string {
  if (/^["']/.test(line)) return 'quoted keys are not supported'
  if (/^[A-Za-z][A-Za-z0-9_-]*\s+:/.test(line)) return 'no space allowed before the colon'
  return 'expected key: value'
}

export function skillFrontmatter(text: string): SkillFrontmatter | null {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  if (lines[0] !== '---') return null
  const end = closingFence(lines)
  if (end < 0) return null
  const next = lines.slice(end + 1).find((line) => line.trim() !== '')
  if (next === '---') return refuse(end + 2, 'a second frontmatter block is not supported')
  const fields = new Map<string, string>()
  for (const [i, line] of lines.slice(1, end).entries()) {
    const at = i + 2
    if (line.trim() === '') continue
    if (line.startsWith('#')) return refuse(at, 'comments are not supported')
    if (/^\s/.test(line)) return refuse(at, 'indented lines are not supported')
    const match = FIELD_LINE.exec(line)
    if (!match?.[1]) return refuse(at, keyProblem(line))
    if (fields.has(match[1])) return refuse(at, `duplicate key '${match[1]}'`)
    const problem = valueProblem(match[2] ?? '')
    if (problem) return refuse(at, problem)
    fields.set(match[1], unquote((match[2] ?? '').trim()))
  }
  const name = fields.get('name')
  const description = fields.get('description')
  if (name === undefined) return { ok: false, error: 'needs a name' }
  if (description === undefined) return { ok: false, error: 'needs a description' }
  if (name === '') return { ok: false, error: 'name is empty' }
  if (description === '') return { ok: false, error: 'description is empty' }
  return { ok: true, name, description }
}

export function loadAgentSkill(
  dir: string,
  extId: string,
  skill: AgentSkillContribution,
): AgentSkillResult {
  let root: string
  try {
    root = realpathSync(dir)
  } catch {
    return { ok: false, error: 'unreadable extension folder' }
  }
  const files: AgentSkillFile[] = []
  let total = 0
  for (const name of [AGENT_SKILL_ENTRY, ...skill.files]) {
    const path = join(root, skill.path, name)
    const file = readConfined(root, path, AGENT_SKILL_FILE_MAX_BYTES)
    if (!file.ok) return { ok: false, error: `${name}: ${file.error}` }
    try {
      if (realpathSync(path) !== path) return { ok: false, error: `${name}: symlink refused` }
    } catch {
      return { ok: false, error: `${name}: unreadable` }
    }
    if (plainText(file.data) === null) return { ok: false, error: `${name}: not plain text` }
    total += file.data.length
    if (total > AGENT_SKILL_MAX_BYTES) {
      return { ok: false, error: `larger than ${AGENT_SKILL_MAX_BYTES} bytes in all` }
    }
    files.push({ name, data: file.data })
  }
  const id = agentSkillId(extId, skill.name)
  const [entry, ...rest] = files
  const front = entry ? skillFrontmatter(entry.data.toString('utf8')) : null
  if (!entry || !front) {
    return { ok: false, error: `${AGENT_SKILL_ENTRY}: needs frontmatter with name and description` }
  }
  if (!front.ok) return { ok: false, error: `${AGENT_SKILL_ENTRY}: ${front.error}` }
  if (front.name !== skill.name) {
    return { ok: false, error: `${AGENT_SKILL_ENTRY}: name must be '${skill.name}'` }
  }
  if (front.description.length > AGENT_SKILL_DESCRIPTION_MAX) {
    return {
      ok: false,
      error: `${AGENT_SKILL_ENTRY}: description is longer than ${AGENT_SKILL_DESCRIPTION_MAX} characters`,
    }
  }
  const renamed = {
    name: entry.name,
    data: Buffer.from(withSkillName(entry.data.toString('utf8'), id)),
  }
  return { ok: true, skill: { id, description: front.description, files: [renamed, ...rest] } }
}

export function withSkillName(text: string, id: string): string {
  const lines = text.split('\n')
  const end = closingFence(lines)
  const at = lines.findIndex((line, i) => {
    const match = FIELD_LINE.exec(line.replace(/\r$/, ''))
    return i > 0 && i < end && match?.[1] === 'name'
  })
  if (at < 0) return text
  lines[at] = `name: ${id}${lines[at]?.endsWith('\r') ? '\r' : ''}`
  return lines.join('\n')
}

export function agentPluginContent(
  sources: readonly AgentPluginSource[],
  onProblem: (extId: string, problem: string) => void = () => {},
): AgentPluginContent {
  const skills: LoadedAgentSkill[] = []
  const hooks: ExtensionAgentHook[] = []
  for (const source of sources) {
    for (const skill of source.skills) {
      const res = loadAgentSkill(source.dir, source.extId, skill)
      if (res.ok) skills.push(res.skill)
      else onProblem(source.extId, `agent skill '${skill.name}': ${res.error}`)
    }
    for (const hook of source.hooks) hooks.push({ extId: source.extId, ...hook })
  }
  return { skills, hooks }
}

export function agentSkillProblems(dir: string, manifest: ExtensionManifest): string[] {
  return (manifest.contributes.agentSkills ?? []).flatMap((skill) => {
    const res = loadAgentSkill(dir, manifest.id, skill)
    return res.ok ? [] : [`agent skill '${skill.name}': ${res.error}`]
  })
}
