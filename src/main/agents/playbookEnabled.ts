import { isBuiltinPlaybookOn, parsePlaybooks } from '../../shared/agents/playbooks'

export function playbookEnabled(raw: unknown, id: string): boolean {
  return isBuiltinPlaybookOn(parsePlaybooks(raw), id)
}
