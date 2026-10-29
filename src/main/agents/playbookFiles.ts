import { skillDirective } from '@aurigax-ai/ostia-extension-sdk/contract/agentPlugins'
import type { PlaybookExtraFile } from '../../shared/agents/onboardPlaybook'
import { activePlaybooks, parsePlaybooks, playbookSkillText } from '../../shared/agents/playbooks'

export interface PlaybookFile {
  id: string
  description: string
  skill: string
  files: readonly PlaybookExtraFile[]
}

let current: unknown

export function setPlaybookSettings(raw: unknown): void {
  current = raw
}

export function currentPlaybookSettings(): unknown {
  return current
}

export function currentPlaybookFiles(takenIds: readonly string[]): PlaybookFile[] {
  return playbookFiles(current, takenIds)
}

export function playbookFiles(raw: unknown, takenIds: readonly string[]): PlaybookFile[] {
  const files: PlaybookFile[] = []
  for (const playbook of activePlaybooks(parsePlaybooks(raw))) {
    if (takenIds.includes(playbook.id)) continue
    const skill = playbookSkillText(playbook)
    if (skillDirective(skill) !== null) continue
    if (playbook.files.some((file) => skillDirective(file.text) !== null)) continue
    files.push({
      id: playbook.id,
      description: playbook.description.replace(/\s+/g, ' ').trim(),
      skill,
      files: playbook.files,
    })
  }
  return files
}
