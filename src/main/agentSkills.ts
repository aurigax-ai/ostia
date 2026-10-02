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

function unquote(value: string): string {
  const trimmed = value.trim()
  const quoted =
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  return quoted ? trimmed.slice(1, -1) : trimmed
}

export function skillFrontmatter(text: string): { name: string; description: string } | null {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  if (lines[0] !== '---') return null
  const end = lines.indexOf('---', 1)
  if (end < 0) return null
  const fields = new Map<string, string>()
  for (const line of lines.slice(1, end)) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):(.*)$/.exec(line)
    if (match?.[1] && match[2] !== undefined) fields.set(match[1], unquote(match[2]))
  }
  const name = fields.get('name')
  const description = fields.get('description')
  if (!name || !description) return null
  return { name, description }
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
  const end = lines.findIndex((line, i) => i > 0 && line.replace(/\r$/, '') === '---')
  const at = lines.findIndex((line, i) => i > 0 && i < end && /^name:/.test(line))
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
