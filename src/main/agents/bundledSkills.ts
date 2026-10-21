import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import browserReference from './skills/ostia/reference/browser.md?raw'
import busReference from './skills/ostia/reference/bus.md?raw'
import capabilitiesReference from './skills/ostia/reference/capabilities.md?raw'
import gitReference from './skills/ostia/reference/git.md?raw'
import graphsReference from './skills/ostia/reference/graphs.md?raw'
import panesReference from './skills/ostia/reference/panes.md?raw'
import previewsReference from './skills/ostia/reference/previews.md?raw'
import reportsReference from './skills/ostia/reference/reports.md?raw'
import sandboxReference from './skills/ostia/reference/sandbox.md?raw'
import serialReference from './skills/ostia/reference/serial.md?raw'
import settingsReference from './skills/ostia/reference/settings.md?raw'
import systemReference from './skills/ostia/reference/system.md?raw'
import viewsReference from './skills/ostia/reference/views.md?raw'
import coreSkill from './skills/ostia/SKILL.md?raw'
import managerSkill from './skills/ostia-manager/SKILL.md?raw'

export interface BundledSkillFile {
  path: string
  text: string
}

export const CORE_SKILL_FILES: readonly BundledSkillFile[] = [
  { path: 'SKILL.md', text: coreSkill },
  { path: 'reference/browser.md', text: browserReference },
  { path: 'reference/bus.md', text: busReference },
  { path: 'reference/capabilities.md', text: capabilitiesReference },
  { path: 'reference/git.md', text: gitReference },
  { path: 'reference/graphs.md', text: graphsReference },
  { path: 'reference/panes.md', text: panesReference },
  { path: 'reference/previews.md', text: previewsReference },
  { path: 'reference/reports.md', text: reportsReference },
  { path: 'reference/sandbox.md', text: sandboxReference },
  { path: 'reference/serial.md', text: serialReference },
  { path: 'reference/settings.md', text: settingsReference },
  { path: 'reference/system.md', text: systemReference },
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
