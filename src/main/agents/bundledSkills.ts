import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import managerSkill from './skills/ostia-manager/SKILL.md?raw'
import coreSkill from './skills/ostia/SKILL.md?raw'
import browserReference from './skills/ostia/reference/browser.md?raw'
import capabilitiesReference from './skills/ostia/reference/capabilities.md?raw'
import reportsReference from './skills/ostia/reference/reports.md?raw'
import viewsReference from './skills/ostia/reference/views.md?raw'

export interface BundledSkillFile {
  path: string
  text: string
}

export const CORE_SKILL_FILES: readonly BundledSkillFile[] = [
  { path: 'SKILL.md', text: coreSkill },
  { path: 'reference/browser.md', text: browserReference },
  { path: 'reference/capabilities.md', text: capabilitiesReference },
  { path: 'reference/reports.md', text: reportsReference },
  { path: 'reference/views.md', text: viewsReference },
]

export const MANAGER_SKILL_FILES: readonly BundledSkillFile[] = [
  { path: 'SKILL.md', text: managerSkill },
]

export function writeBundledSkill(dir: string, files: readonly BundledSkillFile[]): void {
  for (const file of files) {
    const target = join(dir, file.path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, file.text, 'utf8')
  }
}

export function bundledSkillText(files: readonly BundledSkillFile[]): string {
  return files.map((file) => `==> ${file.path} <==\n\n${file.text.trimEnd()}`).join('\n\n')
}
