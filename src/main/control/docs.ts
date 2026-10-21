import { basename } from 'node:path'
import type { ExtensionInfo } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { ErrorCodes, ResponseError } from 'vscode-jsonrpc/node'
import {
  type BundledSkillFile,
  bundledSkillText,
  CORE_SKILL_FILES,
  MANAGER_SKILL_FILES,
} from '../agents/bundledSkills'
import { registerControlMethod } from './controlServer'

type DocsExtension = Pick<ExtensionInfo, 'id' | 'name' | 'commands' | 'verb' | 'agentHooks'>

function extensionCommands(extensions: DocsExtension[]): string {
  const lines: string[] = []
  for (const ext of extensions) {
    const hooks = new Set(ext.agentHooks.map((hook) => hook.command))
    const commands = ext.commands.filter((cmd) => !hooks.has(cmd.id))
    if (commands.length === 0) continue
    lines.push('', `${ext.name} (extension '${ext.id}'):`)
    for (const cmd of commands) {
      lines.push(`  ostia ${ext.verb ?? ext.id} ${cmd.usage ?? cmd.id}  ${cmd.title}`)
    }
  }
  return lines.length > 0 ? `==> extension commands <==\n${lines.join('\n')}` : ''
}

interface Topic {
  name: string
  title: string
  file: BundledSkillFile
}

const SKILL_TOPIC = 'skill'

const TOPICS: Topic[] = CORE_SKILL_FILES.map((file) => ({
  name: file.path === 'SKILL.md' ? SKILL_TOPIC : basename(file.path, '.md'),
  title: /^# (.+)$/m.exec(file.text)?.[1] ?? '',
  file,
}))

function topicList(): string {
  const width = Math.max(...TOPICS.map((topic) => topic.name.length))
  const lines = TOPICS.map((topic) => `  ostia docs ${topic.name.padEnd(width)}  ${topic.title}`)
  return `==> topics <==\n${lines.join('\n')}`
}

export function docsText(extensions: DocsExtension[], manager: boolean, name?: string): string {
  if (name !== undefined) {
    const topic = TOPICS.find((candidate) => candidate.name === name)
    if (!topic) {
      throw new ResponseError(
        ErrorCodes.InvalidParams,
        `unknown-topic: ${name} (topics: ${TOPICS.map((t) => t.name).join(', ')})`,
      )
    }
    return bundledSkillText([topic.file])
  }
  const entry = manager
    ? MANAGER_SKILL_FILES.map((file) => ({ ...file, path: `manager/${file.path}` }))
    : []
  return [bundledSkillText(entry), topicList(), extensionCommands(extensions)]
    .filter(Boolean)
    .join('\n\n')
}

export function registerDocsMethods(deps: { extensions: () => DocsExtension[] }): void {
  registerControlMethod('docs', {
    scripts: true,
    handler: (params, ctx) => {
      const topic = (params as { topic?: unknown } | undefined)?.topic
      return {
        cli: docsText(
          deps.extensions(),
          ctx.identity.manager === true,
          typeof topic === 'string' ? topic : undefined,
        ),
      }
    },
  })
}
