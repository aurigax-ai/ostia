import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentPluginContent } from '@aurigax-ai/ostia-extension-sdk/manifest/agentSkills'
import { version } from '../../../package.json'
import { CORE_SKILL_FILES } from '../agents/bundledSkills'
import { AGENT_SKILL_NAME, writeClaudePlugin } from './claudeIntegration'
import { CODEX_HOOK_ARGS_FILE, writeCodexIntegration } from './codexIntegration'

function agentPluginDigest(content: AgentPluginContent): string {
  const hash = createHash('sha256')
  hash.update(JSON.stringify({ version, hooks: content.hooks }))
  for (const file of CORE_SKILL_FILES) {
    hash.update(JSON.stringify({ path: file.path, size: file.text.length }))
    hash.update(file.text)
  }
  for (const skill of content.skills) {
    hash.update(JSON.stringify({ id: skill.id, description: skill.description }))
    for (const file of skill.files) {
      hash.update(JSON.stringify({ name: file.name, size: file.data.length }))
      hash.update(file.data)
    }
  }
  return hash.digest('hex').slice(0, 32)
}

function agentPluginFiles(content: AgentPluginContent): string[] {
  return [
    join('claude-plugin', '.claude-plugin', 'plugin.json'),
    join('claude-plugin', 'hooks', 'hooks.json'),
    ...CORE_SKILL_FILES.flatMap((file) => [
      join('claude-plugin', 'skills', AGENT_SKILL_NAME, file.path),
      join('codex', file.path),
    ]),
    join('codex', 'session-context.md'),
    join('codex', CODEX_HOOK_ARGS_FILE),
    ...content.skills.flatMap((skill) =>
      skill.files.flatMap((file) => [
        join('claude-plugin', 'skills', skill.id, file.name),
        join('codex', 'skills', skill.id, file.name),
      ]),
    ),
  ]
}

export function hasFiles(dir: string, names: string[]): boolean {
  return names.every((name) => existsSync(join(dir, name)))
}

export function writeAgentPlugin(root: string, content: AgentPluginContent): string {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const dir = join(root, agentPluginDigest(content))
  const names = agentPluginFiles(content)
  if (hasFiles(dir, names)) return dir
  const staging = mkdtempSync(join(root, '.staging-'))
  try {
    writeClaudePlugin(join(staging, 'claude-plugin'), content)
    writeCodexIntegration(join(staging, 'codex'), content, join(dir, 'codex'))
    rmSync(dir, { recursive: true, force: true })
    renameSync(staging, dir)
  } catch (err) {
    rmSync(staging, { recursive: true, force: true })
    if (!hasFiles(dir, names)) throw err
  }
  return dir
}
