import { t } from './panelKit'

export interface FindOutcome {
  proposed: number
  attached: number
  groups: number
  model: string
}

export function findStatus(found: FindOutcome): string {
  if (found.groups > 0 && found.model === 'none') return t('findNoModel')
  if (found.groups > 0 && found.model === 'failed') return t('findFailed')
  if (found.proposed + found.groups > 0) return t('findDone')
  return found.attached > 0 ? t('findAttached') : t('findNothing')
}
