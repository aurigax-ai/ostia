import { basename } from 'node:path'
import type { ExtensionInfo } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { ErrorCodes, ResponseError } from 'vscode-jsonrpc/node'
import {
  type BundledSkillFile,
  CORE_SKILL_FILES,
  MANAGER_SKILL_FILES,
  bundledSkillText,
} from '../agents/bundledSkills'
import { registerControlMethod } from './controlServer'

type DocsExtension = Pick<ExtensionInfo, 'id' | 'name' | 'commands' | 'verb'>

function extensionCommands(extensions: DocsExtension[]): string {
  const lines: string[] = []
  for (const ext of extensions) {
    if (ext.commands.length === 0) continue
    lines.push('', `${ext.name} (extension '${ext.id}'):`)
    for (const cmd of ext.commands) {
      lines.push(`  ostia ${ext.verb ?? ext.id} ${cmd.usage ?? cmd.id}`, `      ${cmd.title}`)
    }
  }
  return lines.length > 0 ? `==> extension commands <==\n${lines.join('\n')}` : ''
}

const TOPICS = CORE_SKILL_FILES.filter((file) => file.path !== 'SKILL.md')

function topicOf(file: BundledSkillFile): string {
  return basename(file.path, '.md')
}

function topicList(): string {
  const width = Math.max(...TOPICS.map((file) => topicOf(file).length))
  const lines = TOPICS.map((file) => {
    const title = file.text.split('\n')[0].replace(/^#\s*/, '')
    return `  ostia docs ${topicOf(file).padEnd(width)}  ${title}`
  })
  return `==> topics <==\n${lines.join('\n')}`
}

export function docsText(extensions: DocsExtension[], manager: boolean, topic?: string): string {
  if (topic !== undefined) {
    const file = TOPICS.find((candidate) => topicOf(candidate) === topic)
    if (!file) {
      throw new ResponseError(
        ErrorCodes.InvalidParams,
        `unknown-topic: ${topic} (topics: ${TOPICS.map(topicOf).join(', ')})`,
      )
    }
    return bundledSkillText([file])
  }
  const entry = [
    CORE_SKILL_FILES[0],
    ...(manager
      ? MANAGER_SKILL_FILES.map((file) => ({ ...file, path: `manager/${file.path}` }))
      : []),
  ]
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
