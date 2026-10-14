import type { ExtensionInfo } from '../../shared/extensions'
import { CORE_SKILL_FILES, MANAGER_SKILL_FILES, bundledSkillText } from '../agents/bundledSkills'
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

export function docsText(extensions: DocsExtension[], manager: boolean): string {
  const manual = manager
    ? [
        ...CORE_SKILL_FILES,
        ...MANAGER_SKILL_FILES.map((file) => ({ ...file, path: `manager/${file.path}` })),
      ]
    : CORE_SKILL_FILES
  return [bundledSkillText(manual), extensionCommands(extensions)].filter(Boolean).join('\n\n')
}

export function registerDocsMethods(deps: { extensions: () => DocsExtension[] }): void {
  registerControlMethod('docs', {
    scripts: true,
    handler: (_params, ctx) => ({
      cli: docsText(deps.extensions(), ctx.identity.manager === true),
    }),
  })
}
