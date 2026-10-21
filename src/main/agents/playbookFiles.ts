import { skillDirective } from '@aurigax-ai/ostia-extension-sdk/manifest/agentSkills'
import { activePlaybooks, parsePlaybooks, playbookSkillText } from '../../shared/agents/playbooks'

export interface PlaybookFile {
  id: string
  description: string
  skill: string
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
