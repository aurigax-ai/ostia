import type { Translate } from '@aurigax-ai/pine-extension-sdk'
import type { CardDetail, TrellisProject } from './trellis'

export const PROMPT_BODY_MAX = 6000
export const OFFER_LABEL_MAX = 120
export const TASK_SKILL = 'trellis-card'

const REVIEW_COLUMN = /review/i

export function reviewColumn(columns: string[]): string | null {
  return columns.find((name) => REVIEW_COLUMN.test(name) && /^[^\s'"`]+$/.test(name)) ?? null
}

function withoutControls(text: string, keep: string): string {
  let out = ''
  for (const ch of text) out += (ch < ' ' || ch === '\x7f') && !keep.includes(ch) ? ' ' : ch
  return out
}

function oneLine(text: string): string {
  return withoutControls(text, '').replace(/\s+/g, ' ').trim()
}

function promptBody(body: string, t: Translate): string {
  const text = withoutControls(body.replace(/\r\n?/g, '\n'), '\n').trim()
  if (text.length <= PROMPT_BODY_MAX) return text
  return `${text.slice(0, PROMPT_BODY_MAX).trimEnd()}\n\n${t('task.bodyCut')}`
}

function lastStep(ref: string, review: string | null, t: Translate): string {
  return review ? t('task.lastReview', { ref, column: review }) : t('task.lastReviewAny')
}

export function taskPrompt(card: CardDetail, review: string | null, t: Translate): string {
  const ref = card.ref
  return [
    t('task.heading', { ref, title: oneLine(card.title) }),
    promptBody(card.body, t),
    t('task.how', { ref, skill: TASK_SKILL, last: lastStep(ref, review, t) }),
  ]
    .filter(Boolean)
    .join('\n\n')
}

export function taskLine(card: CardDetail, review: string | null, t: Translate): string {
  const ref = card.ref
  return oneLine(
    t('task.line', {
      ref,
      title: oneLine(card.title),
      skill: TASK_SKILL,
      last: lastStep(ref, review, t),
    }),
  )
}

export function sessionContext(project: TrellisProject | null): string {
  if (!project) return ''
  const board = project.board ? `, board ${project.board}` : ''
  return `This folder belongs to Trellis project ${project.project}${board}. The ${TASK_SKILL} skill explains how to work on one of its cards.`
}

export function taskLabel(card: CardDetail): string {
  const label = `${card.ref} · ${oneLine(card.title)}`
  return label.length <= OFFER_LABEL_MAX ? label : `${label.slice(0, OFFER_LABEL_MAX - 1)}…`
}
