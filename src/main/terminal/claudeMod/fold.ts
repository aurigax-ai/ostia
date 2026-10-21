export const FOLD_ROW_ORIGIN = 'ostia'
const BUS_MESSAGE_TAG = /^<message id="[^"]*" from="([^"]*)"(?: name="([^"]*)")?>$/gm

interface UserMessageEvent {
  props?: {
    text: string
    isExpanded: boolean
    origin: { kind: string; name?: string }
  }
}

type Next = (e?: unknown) => Promise<unknown>
type Hook = ($: unknown, e: UserMessageEvent, next: Next) => unknown
export type FoldOn = (event: string, match: { component: string }, hook: Hook) => unknown

function foldedRow(text: string): string | undefined {
  const tags = [...text.matchAll(BUS_MESSAGE_TAG)]
  if (tags.length === 0) return undefined
  const senders = new Set(tags.map(([, from, name]) => `@${name || from}`))
  const noun = tags.length === 1 ? 'Message' : 'Messages'
  return `${noun} from ${[...senders].join(', ')} (ctrl+o to expand)`
}

export const register = (on: FoldOn): void => {
  on('ui.render', { component: 'UserMessage' }, (_$, e, next) => {
    const props = e.props
    if (!props || props.isExpanded) return next(e)
    if (props.origin.kind !== 'plugin' || props.origin.name !== FOLD_ROW_ORIGIN) return next(e)
    const row = foldedRow(props.text)
    return next(row ? { ...e, props: { ...props, text: row } } : e)
  })
}
