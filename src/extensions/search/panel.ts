import caretDown from '@phosphor-icons/core/regular/caret-down.svg'
import caretRight from '@phosphor-icons/core/regular/caret-right.svg'
import type { ExtensionResult } from '../../shared/extensions'
import { call, context, errorText, h, icon, pickLocale } from '../sdk/panel'
import type { FuzzyHit } from './fuzzy'
import type { FileMatches, LineMatch, TextResults } from './rg'

type Mode = 'text' | 'files'

interface TextData extends TextResults {
  root: string
}

interface NamesData {
  root: string
  hits: FuzzyHit[]
  truncated: boolean
}

interface Target {
  path: string
  line?: number
  column?: number
}

const TEXT_DELAY_MS = 200
const NAMES_DELAY_MS = 60

const t = pickLocale({
  en: {
    modes: { text: 'Text', files: 'Files' },
    textPlaceholder: 'Find in files',
    filesPlaceholder: 'Go to file by name',
    include: 'Files to include, e.g. src/**, *.ts',
    exclude: 'Files to exclude, e.g. dist/**',
    caseSensitive: 'Match case',
    wholeWord: 'Match whole word',
    regex: 'Use regular expression',
    searching: 'Searching…',
    noFolder: 'This workspace has no folder to search.',
    noMatches: 'No matches',
    noFiles: 'No files match',
    typeToSearch: 'Type to search the workspace folder.',
    typeToFind: 'Type part of a file name.',
    summary: (matches: number, files: number) =>
      `${matches} ${matches === 1 ? 'match' : 'matches'} in ${files} ${files === 1 ? 'file' : 'files'}`,
    truncated: 'Showing the first results only; narrow the search.',
    listTruncated: 'The folder has more files than the list holds; some are not offered.',
    rgMissing: 'Search needs ripgrep (rg), which is not installed.',
  },
  'zh-Hant': {
    modes: { text: '文字', files: '檔案' },
    textPlaceholder: '在檔案中尋找',
    filesPlaceholder: '依名稱前往檔案',
    include: '要包含的檔案，例如 src/**、*.ts',
    exclude: '要排除的檔案，例如 dist/**',
    caseSensitive: '大小寫須相符',
    wholeWord: '須為完整單字',
    regex: '使用規則運算式',
    searching: '搜尋中…',
    noFolder: '這個工作區沒有可搜尋的資料夾。',
    noMatches: '沒有相符的結果',
    noFiles: '沒有相符的檔案',
    typeToSearch: '輸入文字以搜尋工作區資料夾。',
    typeToFind: '輸入檔案名稱的一部分。',
    summary: (matches: number, files: number) => `${files} 個檔案中有 ${matches} 個相符結果`,
    truncated: '只顯示前面的結果；請縮小搜尋範圍。',
    listTruncated: '資料夾的檔案多於清單的上限；部分檔案不會列出。',
    rgMissing: '搜尋需要 ripgrep（rg），但尚未安裝。',
  },
})

const params = new URLSearchParams(location.search)
let mode: Mode = params.get('mode') === 'files' ? 'files' : 'text'
const options = { caseSensitive: false, wholeWord: false, regex: false }
const collapsed = new Set<string>()
let targets: Target[] = []
let selected = 0
let seq = 0
let timer: ReturnType<typeof setTimeout> | undefined

const query = h('input', {
  type: 'search',
  class: 'query',
  spellcheck: 'false',
  autocomplete: 'off',
}) as HTMLInputElement
const include = h('input', {
  class: 'glob',
  spellcheck: 'false',
  'aria-label': t.include,
  placeholder: t.include,
}) as HTMLInputElement
const exclude = h('input', {
  class: 'glob',
  spellcheck: 'false',
  'aria-label': t.exclude,
  placeholder: t.exclude,
}) as HTMLInputElement
const status = h('div', { class: 'status muted', role: 'status' })
const results = h('div', { class: 'results', role: 'listbox' })
const tabs = h('nav', { class: 'tabs', role: 'tablist' })
const toggles = h('div', { class: 'toggles' })
const globs = h('div', { class: 'globs' }, include, exclude)

function globList(input: HTMLInputElement): string[] {
  return input.value
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean)
}

function rgError(res: ExtensionResult): string {
  if (!res.ok && res.error === 'rg-missing') return t.rgMissing
  if (!res.ok && res.error === 'no-folder') return t.noFolder
  return errorText(res)
}

function marked(text: string, ranges: [number, number][]): (Node | string)[] {
  const parts: (Node | string)[] = []
  let at = 0
  for (const [from, to] of ranges) {
    if (from > at) parts.push(text.slice(at, from))
    parts.push(h('mark', {}, text.slice(from, to)))
    at = to
  }
  if (at < text.length) parts.push(text.slice(at))
  return parts
}

function positionsToRanges(positions: number[], offset: number): [number, number][] {
  const ranges: [number, number][] = []
  for (const pos of positions) {
    const p = pos - offset
    if (p < 0) continue
    const last = ranges[ranges.length - 1]
    if (last && last[1] === p) last[1] = p + 1
    else ranges.push([p, p + 1])
  }
  return ranges
}

async function open(target: Target): Promise<void> {
  const res = await call('open', target)
  if (!res.ok) status.textContent = errorText(res)
}

function select(index: number): void {
  if (targets.length === 0) return
  selected = Math.max(0, Math.min(targets.length - 1, index))
  for (const row of results.querySelectorAll('[data-index]')) {
    const on = Number((row as HTMLElement).dataset.index) === selected
    row.setAttribute('aria-selected', on ? 'true' : 'false')
    if (on) (row as HTMLElement).scrollIntoView({ block: 'nearest' })
  }
}

function targetRow(target: Target, ...children: (Node | string)[]): HTMLElement {
  const index = targets.length
  targets.push(target)
  return h(
    'div',
    {
      class: 'hit',
      role: 'option',
      'data-index': String(index),
      'aria-selected': index === selected ? 'true' : 'false',
      onclick: () => {
        select(index)
        void open(target)
      },
    },
    ...children,
  )
}

function splitPath(path: string): { dir: string; name: string } {
  const slash = path.lastIndexOf('/')
  return { dir: slash < 0 ? '' : path.slice(0, slash + 1), name: path.slice(slash + 1) }
}

function fileGroup(file: FileMatches): HTMLElement {
  const { dir, name } = splitPath(file.path)
  const closed = collapsed.has(file.path)
  const header = h(
    'button',
    {
      class: 'file',
      'aria-expanded': closed ? 'false' : 'true',
      title: file.path,
      onclick: () => {
        if (closed) collapsed.delete(file.path)
        else collapsed.add(file.path)
        renderText(lastText)
      },
    },
    icon(closed ? caretRight : caretDown),
    h('span', { class: 'name' }, name),
    h('span', { class: 'dir muted' }, dir),
    h('span', { class: 'count muted' }, String(file.matches.length)),
  )
  const lines = closed
    ? []
    : file.matches.map((m: LineMatch) =>
        targetRow(
          { path: file.path, line: m.line, column: m.column },
          h('span', { class: 'line muted' }, String(m.line)),
          h('span', { class: 'text' }, ...marked(m.text, m.ranges)),
        ),
      )
  return h('div', { class: 'group' }, header, ...lines)
}

let lastText: TextData | null = null

function renderText(data: TextData | null): void {
  lastText = data
  targets = []
  if (!data) {
    results.replaceChildren()
    return
  }
  results.replaceChildren(...data.files.map(fileGroup))
  select(selected)
  const summary = data.matches === 0 ? t.noMatches : t.summary(data.matches, data.files.length)
  status.textContent = data.truncated ? `${summary}. ${t.truncated}` : summary
}

function renderNames(data: NamesData): void {
  targets = []
  results.replaceChildren(
    ...data.hits.map((hit) => {
      const { dir, name } = splitPath(hit.path)
      return targetRow(
        { path: hit.path },
        h('span', { class: 'name' }, ...marked(name, positionsToRanges(hit.positions, dir.length))),
        h('span', { class: 'dir muted' }, dir),
      )
    }),
  )
  select(selected)
  const empty = data.hits.length === 0 ? t.noFiles : ''
  status.textContent = data.truncated ? [empty, t.listTruncated].filter(Boolean).join(' ') : empty
}

async function runText(): Promise<void> {
  const id = ++seq
  const text = query.value
  if (!text) {
    status.textContent = t.typeToSearch
    renderText(null)
    return
  }
  status.textContent = t.searching
  const res = await call('text', {
    text,
    ...options,
    include: globList(include),
    exclude: globList(exclude),
  })
  if (id !== seq) return
  if (!res.ok) {
    if (res.error === 'cancelled') return
    renderText(null)
    status.textContent = rgError(res)
    return
  }
  selected = 0
  renderText(res.data as TextData)
}

async function runNames(): Promise<void> {
  const id = ++seq
  if (!query.value.trim()) {
    targets = []
    results.replaceChildren()
    status.textContent = t.typeToFind
    return
  }
  const res = await call('names', { query: query.value })
  if (id !== seq) return
  if (!res.ok) {
    results.replaceChildren()
    status.textContent = rgError(res)
    return
  }
  selected = 0
  renderNames(res.data as NamesData)
}

function schedule(): void {
  clearTimeout(timer)
  timer = setTimeout(
    () => void (mode === 'text' ? runText() : runNames()),
    mode === 'text' ? TEXT_DELAY_MS : NAMES_DELAY_MS,
  )
}

function toggle(key: keyof typeof options, label: string, text: string): HTMLElement {
  const button = h(
    'button',
    {
      class: 'toggle',
      'aria-label': label,
      title: label,
      'aria-pressed': 'false',
      onclick: () => {
        options[key] = !options[key]
        button.setAttribute('aria-pressed', options[key] ? 'true' : 'false')
        schedule()
      },
    },
    text,
  )
  return button
}

function setMode(next: Mode): void {
  mode = next
  seq++
  targets = []
  selected = 0
  results.replaceChildren()
  status.textContent = ''
  for (const tab of tabs.querySelectorAll('button.tab')) {
    const on = (tab as HTMLElement).dataset.mode === mode
    tab.setAttribute('aria-selected', on ? 'true' : 'false')
  }
  toggles.hidden = mode !== 'text'
  globs.hidden = mode !== 'text'
  query.placeholder = mode === 'text' ? t.textPlaceholder : t.filesPlaceholder
  query.setAttribute('aria-label', query.placeholder)
  query.focus()
  query.select()
  schedule()
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    select(selected + 1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    select(selected - 1)
  } else if (e.key === 'Enter') {
    e.preventDefault()
    clearTimeout(timer)
    const target = targets[selected]
    if (target) void open(target)
    else void (mode === 'text' ? runText() : runNames())
  }
}

function mount(): void {
  for (const m of ['text', 'files'] as Mode[]) {
    tabs.append(
      h(
        'button',
        { class: 'tab', role: 'tab', 'data-mode': m, onclick: () => setMode(m) },
        t.modes[m],
      ),
    )
  }
  toggles.append(
    toggle('caseSensitive', t.caseSensitive, 'Aa'),
    toggle('wholeWord', t.wholeWord, 'ab'),
    toggle('regex', t.regex, '.*'),
  )
  query.addEventListener('input', schedule)
  query.addEventListener('keydown', onKey)
  include.addEventListener('input', schedule)
  exclude.addEventListener('input', schedule)
  const root = h(
    'div',
    { class: 'page' },
    tabs,
    h('div', { class: 'controls' }, h('div', { class: 'query-row' }, query, toggles), globs),
    status,
    results,
  )
  document.getElementById('root')?.replaceChildren(root)
  if (!context.workDir) status.textContent = t.noFolder
  setMode(mode)
}

mount()
