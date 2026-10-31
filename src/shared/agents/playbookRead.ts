import { activePlaybooks, type PlaybooksSettings } from './playbooks'

const SKILL_FILE = 'SKILL.md'

export type PlaybookRead = { ok: true; text: string } | { ok: false; error: string }

export function readPlaybook(
  settings: PlaybooksSettings,
  name: string,
  file?: string,
): PlaybookRead {
  const playbook = activePlaybooks(settings).find((p) => p.id === name)
  if (!playbook) return { ok: false, error: `No enabled playbook named ${name}.` }
  if (file === undefined || file === SKILL_FILE) return { ok: true, text: playbook.text }
  const found = playbook.files.find((f) => f.path === file)
  return found
    ? { ok: true, text: found.text }
    : { ok: false, error: `${name} has no file ${file}.` }
}

export function playbookListText(settings: PlaybooksSettings): string {
  const active = activePlaybooks(settings)
  if (active.length === 0) return ''
  return [
    'Playbooks the human turned on. Load one with ostia_skill when its description fits the task:',
    ...active.map((p) => `- ${p.id}: ${p.description.replace(/\s+/g, ' ').trim()}`),
  ].join('\n')
}
