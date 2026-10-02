import type { Translate } from '@aurigax-ai/pine-extension-sdk'
import type { CardDetail } from './trellis'

export const PROMPT_BODY_MAX = 6000
export const OFFER_LABEL_MAX = 120

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
  return review ? t('task.stepReview', { ref, column: review }) : t('task.stepReviewAny')
}

export function taskPrompt(card: CardDetail, review: string | null, t: Translate): string {
  const ref = card.ref
  const body = promptBody(card.body, t)
  return [
    t('task.heading', { ref, title: oneLine(card.title) }),
    body,
    [
      t('task.steps'),
      `1. ${t('task.stepShow', { ref })}`,
      `2. ${t('task.stepClaim', { ref })}`,
      `3. ${t('task.stepComment', { ref })}`,
      `4. ${lastStep(ref, review, t)}`,
    ].join('\n'),
  ]
    .filter(Boolean)
    .join('\n\n')
}

export function taskLine(card: CardDetail, review: string | null, t: Translate): string {
  const ref = card.ref
  const last = review ? t('task.lineReview', { ref, column: review }) : t('task.lineReviewAny')
  return oneLine(t('task.line', { ref, title: oneLine(card.title), last }))
}

export function taskLabel(card: CardDetail): string {
  const label = `${card.ref} · ${oneLine(card.title)}`
  return label.length <= OFFER_LABEL_MAX ? label : `${label.slice(0, OFFER_LABEL_MAX - 1)}…`
}
