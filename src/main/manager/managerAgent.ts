import {
  existsSync,
  lstatSync,
  mkdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, join } from 'node:path'
import type { AgentResume, ResumableAgent } from '../../shared/agents/agentResume'
import { PRODUCT_NAME } from '../../shared/product'
import managerSkill from '../agents/ostia-manager-skill.md?raw'
import {
  CLAUDE_PLUGIN_MANIFEST,
  claudeHookSettings,
  codexHookArgs,
} from '../terminal/shellIntegration'

export const MANAGER_SKILL_NAME = `${PRODUCT_NAME}-manager`

export function managerAgentKind(program: string): ResumableAgent | null {
  const name = basename(program)
  return name === 'claude' || name === 'codex' ? name : null
}

export function usableSkillFolders(folders: readonly string[]): string[] {
  const usable: string[] = []
  const names = new Set<string>([MANAGER_SKILL_NAME])
  for (const folder of folders) {
    const name = basename(folder)
    if (names.has(name)) continue
    try {
      if (!statSync(folder).isDirectory() || !statSync(join(folder, 'SKILL.md')).isFile()) continue
    } catch {
      continue
    }
    names.add(name)
    usable.push(folder)
  }
  return usable
}

export function writeManagerClaudePlugin(dir: string, skillFolders: readonly string[]): void {
  if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) throw new Error(`refusing symlink ${dir}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
  mkdirSync(join(dir, 'hooks'), { recursive: true })
  mkdirSync(join(dir, 'skills', MANAGER_SKILL_NAME), { recursive: true })
  writeFileSync(
    join(dir, '.claude-plugin', 'plugin.json'),
    `${JSON.stringify(
      {
        ...CLAUDE_PLUGIN_MANIFEST,
        name: MANAGER_SKILL_NAME,
        description: `${PRODUCT_NAME} manager: the manager skill, the skills the human picked, and hooks for the resume token and attention state.`,
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  writeFileSync(
    join(dir, 'hooks', 'hooks.json'),
    `${JSON.stringify(claudeHookSettings(), null, 2)}\n`,
    'utf8',
  )
  writeFileSync(join(dir, 'skills', MANAGER_SKILL_NAME, 'SKILL.md'), managerSkill, 'utf8')
  for (const folder of usableSkillFolders(skillFolders)) {
    symlinkSync(folder, join(dir, 'skills', basename(folder)), 'dir')
  }
}

export function writeManagerCodexContext(dir: string, skillFolders: readonly string[]): string {
  mkdirSync(dir, { recursive: true })
  const skillFile = join(dir, 'SKILL.md')
  writeFileSync(skillFile, managerSkill, 'utf8')
  const extra = usableSkillFolders(skillFolders).map((f) => `- ${join(f, 'SKILL.md')}`)
  const contextFile = join(dir, 'context.md')
  writeFileSync(
    contextFile,
    [
      `You are the ${PRODUCT_NAME} manager. Before you act, read your guide: ${skillFile}`,
      ...(extra.length > 0
        ? ['', 'The human also gave you these skills; read one when its task comes up:', ...extra]
        : []),
      '',
    ].join('\n'),
    'utf8',
  )
  return contextFile
}

export interface ManagerArgvOptions {
  claudePluginDir: string
  codexContextFile: string
  resume: AgentResume | null
}

export function resumeArgs(resume: AgentResume): string[] {
  return resume.agent === 'claude' ? ['--resume', resume.id] : ['resume', resume.id]
}

export function managerArgv(argv: readonly string[], opts: ManagerArgvOptions): string[] {
  const [program, ...rest] = argv
  if (!program) return []
  const kind = managerAgentKind(program)
  const resume = opts.resume && opts.resume.agent === kind ? resumeArgs(opts.resume) : []
  if (kind === 'claude') {
    return [program, '--plugin-dir', opts.claudePluginDir, ...resume, ...rest]
  }
  if (kind === 'codex') {
    return [program, ...codexHookArgs(opts.codexContextFile), ...resume, ...rest]
  }
  return [program, ...rest]
}
