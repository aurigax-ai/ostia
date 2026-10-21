import { skillDirective } from '@aurigax-ai/ostia-extension-sdk/contract/agentPlugins'
import { activePlaybooks, parsePlaybooks, playbookSkillText } from '../../shared/agents/playbooks'

export interface PlaybookFile {
  id: string
  description: string
  skill: string
}

let current: unknown

export function setPlaybookSettings(raw: unknown): void {
  current = raw
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
    files.push({
      id: playbook.id,
      description: playbook.description.replace(/\s+/g, ' ').trim(),
      skill,
    })
  }
  return files
}
