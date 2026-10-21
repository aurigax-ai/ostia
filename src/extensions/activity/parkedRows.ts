import { h, icon, quietButton } from '@aurigax-ai/ostia-extension-sdk/panel'
import bookmarkSimple from '@phosphor-icons/core/regular/bookmark-simple.svg'
import { createPatcher, type Item, type Row, setAttr, setText } from './listPatch'
import type { ParkedView } from './parkedView'
import { ageText, type RowEnv } from './rows'

export type ParkedEnv = Pick<RowEnv, 't' | 'now'> & {
  resume: (id: string) => void
  forget: (id: string) => void
  line: (id: string) => { text: string; error: boolean } | undefined
}

interface ParkedRowItem {
  parked: ParkedView
  line: { text: string; error: boolean } | undefined
}

function metaText(env: ParkedEnv, parked: ParkedView): string {
  const agent = env.t(`agent.${parked.agent}`)
  const parts = [agent, parked.title]
  parts.push(ageText(env, parked.parkedAt))
  if (parked.tasks > 0) parts.push(env.t('parked.tasks', { count: parked.tasks }))
  return parts.join(' · ')
}

function parkedRow(env: ParkedEnv): Row<ParkedRowItem> {
  const summary = h('p', { class: 'note-text' })
  const note = h('p', { class: 'line-note', hidden: true })
  const meta = h('span', { class: 'grow' })
  let current: ParkedView | null = null
  const resume = quietButton(env.t('parked.resume'), () => current && env.resume(current.id), true)
  const forget = quietButton(env.t('parked.unpark'), () => current && env.forget(current.id))
  const line = h('p', { class: 'line-note', role: 'status', hidden: true })
  const body = h(
    'div',
    { class: 'item-body' },
    summary,
    note,
    h('div', { class: 'item-meta' }, meta, h('span', { class: 'item-actions' }, resume, forget)),
    line,
  )
  const el = h('li', { class: 'note-row item', 'data-parked': '' }, icon(bookmarkSimple), body)
  return {
    el,
    update: ({ parked, line: status }) => {
      current = parked
      const changed: HTMLElement[] = []
      if (setText(summary, parked.summary ?? parked.title)) changed.push(summary)
      note.hidden = parked.note === undefined
      setText(note, parked.note ? `“${parked.note}”` : '')
      setText(meta, metaText(env, parked))
      line.hidden = status === undefined
      setText(line, status?.text ?? '')
      line.classList.toggle('err', status?.error === true)
      setAttr(el, 'data-id', parked.id)
      setAttr(el, 'title', parked.folder ?? null)
      return changed
    },
  }
}

export function createParkedView(
  container: HTMLElement,
  env: ParkedEnv,
): (items: readonly ParkedView[]) => void {
  const list = h('ul', { class: 'notes' })
  const empty = h('p', { class: 'ostia-empty' })
  container.replaceChildren(list, empty)
  const patch = createPatcher<ParkedRowItem>(
    list,
    (item) => {
      const row = parkedRow(env)
      row.update(item)
      return row
    },
    env.now,
  )
  return (items) => {
    empty.hidden = items.length > 0
    setText(empty, items.length > 0 ? '' : env.t('parked.empty'))
    const rows: Item<ParkedRowItem>[] = items.map((parked) => {
      const line = env.line(parked.id)
      return {
        key: parked.id,
        sig: JSON.stringify([parked, line, ageText(env, parked.parkedAt)]),
        value: { parked, line },
      }
    })
    patch(rows)
  }
}
