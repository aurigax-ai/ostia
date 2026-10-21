import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { AGENT_SKILL_ENTRY } from '@aurigax-ai/ostia-extension-sdk/contract/agentPlugins'
import type { AgentPluginContent } from '@aurigax-ai/ostia-extension-sdk/manifest/agentSkills'
import { version } from '../../../package.json'
import { CODEX_HOOK_ARGS_JSON } from '../../shared/agents/agentLaunch'
import { CORE_SKILL_FILES } from '../agents/bundledSkills'
import type { PlaybookFile } from '../agents/playbookFiles'
import {
  AGENT_SKILL_NAME,
  CLAUDE_FOLD_DIR,
  CLAUDE_FOLD_SOURCE,
  CLAUDE_MOD_FILE,
  CLAUDE_MOD_SOURCE,
  claudeHookSettings,
  writeClaudeFoldPlugin,
  writeClaudePlugin,
} from './claudeIntegration'
import {
  CODEX_HOOK_ARGS_FILE,
  codexHookArgs,
  PLAYBOOKS_DIR,
  writeCodexIntegration,
} from './codexIntegration'

export function agentPluginDigest(
  content: AgentPluginContent,
  playbooks: readonly PlaybookFile[],
): string {
  const hash = createHash('sha256')
  hash.update(
    JSON.stringify({
      version,
      claudeHooks: claudeHookSettings(content.hooks),
      claudeMod: CLAUDE_MOD_SOURCE,
      claudeFold: CLAUDE_FOLD_SOURCE,
      codexHookArgs: codexHookArgs('', content.hooks),
    }),
  )
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
  for (const playbook of playbooks) {
    hash.update(JSON.stringify({ playbook: playbook.id, size: playbook.skill.length }))
    hash.update(playbook.skill)
  }
  return hash.digest('hex').slice(0, 32)
}

export function agentPluginFiles(
  content: AgentPluginContent,
  playbooks: readonly PlaybookFile[] = [],
): string[] {
  return [
    join('claude-plugin', '.claude-plugin', 'plugin.json'),
    join('claude-plugin', 'hooks', 'hooks.json'),
    join('claude-plugin', 'hooks', CLAUDE_MOD_FILE),
    join(CLAUDE_FOLD_DIR, '.claude-plugin', 'plugin.json'),
    join(CLAUDE_FOLD_DIR, 'hooks', 'hooks.json'),
    join(CLAUDE_FOLD_DIR, 'hooks', CLAUDE_MOD_FILE),
    ...CORE_SKILL_FILES.flatMap((file) => [
      join('claude-plugin', 'skills', AGENT_SKILL_NAME, file.path),
      join('codex', file.path),
    ]),
    join('codex', 'session-context.md'),
    join('codex', CODEX_HOOK_ARGS_FILE),
    join('codex', CODEX_HOOK_ARGS_JSON),
    ...content.skills.flatMap((skill) =>
      skill.files.flatMap((file) => [
        join('claude-plugin', 'skills', skill.id, file.name),
        join('codex', 'skills', skill.id, file.name),
      ]),
    ),
    ...playbooks.flatMap((playbook) => [
      join('claude-plugin', 'skills', playbook.id, AGENT_SKILL_ENTRY),
      join('codex', PLAYBOOKS_DIR, playbook.id, AGENT_SKILL_ENTRY),
    ]),
  ]
}

export function hasFiles(dir: string, names: string[]): boolean {
  return names.every((name) => existsSync(join(dir, name)))
}

export function writeAgentPlugin(
  root: string,
  content: AgentPluginContent,
  playbooks: readonly PlaybookFile[] = [],
): string {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const dir = join(root, agentPluginDigest(content, playbooks))
  const names = agentPluginFiles(content, playbooks)
  if (hasFiles(dir, names)) return dir
  const staging = mkdtempSync(join(root, '.staging-'))
  try {
    writeClaudePlugin(join(staging, 'claude-plugin'), content, playbooks)
    writeClaudeFoldPlugin(join(staging, CLAUDE_FOLD_DIR))
    writeCodexIntegration(join(staging, 'codex'), content, join(dir, 'codex'), playbooks)
    rmSync(dir, { recursive: true, force: true })
    renameSync(staging, dir)
  } catch (err) {
    rmSync(staging, { recursive: true, force: true })
    if (!hasFiles(dir, names)) throw err
  }
  return dir
}
