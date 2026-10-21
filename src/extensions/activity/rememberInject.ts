import { type RememberItem, startOf } from './rememberItem'
import { ageOf } from './view'

const INJECT_ITEMS_MAX = 10
export const INJECT_CHARS_MAX = 1200

const HEADER =
  'Ostia remembered tasks for this session. You saved them with `ostia activity remember`; mark one finished with `ostia activity done <id>`.'
const MORE = (count: number) => `+${count} more: ostia activity list --remembered`

function whenText(item: RememberItem, now: number): string {
  const age = ageOf(startOf(item), now)
  return age.unit === 'days' ? `${age.count} d ago` : 'today'
}

function lineOf(item: RememberItem, now: number): string {
  return `- [${item.id}] ${item.text} (${whenText(item, now)})`
}

export function injectionOf(
  items: readonly RememberItem[],
  now: number,
): { text: string; count: number } {
  if (items.length === 0) return { text: '', count: 0 }
  const lines: string[] = []
  let length = HEADER.length
  for (const item of items.slice(0, INJECT_ITEMS_MAX)) {
    const line = lineOf(item, now)
    if (length + 1 + line.length > INJECT_CHARS_MAX) break
    lines.push(line)
    length += 1 + line.length
  }
  while (
    lines.length > 1 &&
    lines.length < items.length &&
    length + 1 + MORE(items.length - lines.length).length > INJECT_CHARS_MAX
  ) {
    length -= 1 + (lines.pop()?.length ?? 0)
  }
  const left = items.length - lines.length
  const text = [HEADER, ...lines, ...(left > 0 ? [MORE(left)] : [])].join('\n')
  return { text, count: lines.length }
}
