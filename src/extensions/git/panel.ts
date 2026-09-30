import arrowClockwise from '@phosphor-icons/core/regular/arrow-clockwise.svg'
import arrowCounterClockwise from '@phosphor-icons/core/regular/arrow-counter-clockwise.svg'
import caretDown from '@phosphor-icons/core/regular/caret-down.svg'
import caretRight from '@phosphor-icons/core/regular/caret-right.svg'
import minus from '@phosphor-icons/core/regular/minus.svg'
import plus from '@phosphor-icons/core/regular/plus.svg'
import { call, context, errorText, h, icon, onChange, pickLocale } from '../sdk/panel'
import type { BlameLine, CommitFile, CommitSummary } from './history'
import type { BranchInfo, ChangeArea, FileChange, StatusSummary } from './status'

interface ChangesData {
  root: string
  branch: BranchInfo
  counts: StatusSummary
  changes: FileChange[]
}

interface LogData {
  root: string
  branch: string | null
  commits: CommitSummary[]
}

interface CommitFilesData {
  root: string
  commit: CommitSummary
  files: CommitFile[]
}

interface BlameData {
  root: string
  path: string
  lines: BlameLine[]
}

type Page = 'changes' | 'log' | 'blame'

const t = pickLocale({
  en: {
    loading: 'Loading…',
    refresh: 'Refresh',
    clean: 'No changes',
    notRepo: 'Not in a git repository',
    detached: 'detached',
    ahead: 'ahead',
    behind: 'behind',
    openDiff: 'Open diff',
    tabs: { changes: 'Changes', log: 'Log', blame: 'Blame' } as Record<Page, string>,
    stage: 'Stage',
    unstage: 'Unstage',
    discard: 'Discard changes',
    stageAll: 'Stage all',
    unstageAll: 'Unstage all',
    discardAll: 'Discard all',
    commitPlaceholder: 'Commit message',
    commit: 'Commit',
    committed: (sha: string) => `Committed ${sha}`,
    noCommits: 'No commits yet',
    showFiles: 'Show files',
    hideFiles: 'Hide files',
    noFiles: 'No file changes',
    noBlameFile: 'Open a file and run Git: Blame File',
    uncommitted: 'Not committed yet',
    areas: {
      conflicted: 'Conflicts',
      staged: 'Staged',
      unstaged: 'Changes',
      untracked: 'Untracked',
    } as Record<ChangeArea, string>,
    codes: {
      M: 'modified',
      A: 'added',
      D: 'deleted',
      R: 'renamed',
      C: 'copied',
      T: 'type changed',
      U: 'conflict',
      '?': 'untracked',
    } as Record<string, string>,
  },
  'zh-Hant': {
    loading: '載入中…',
    refresh: '重新整理',
    clean: '沒有變更',
    notRepo: '不在 git 儲存庫中',
    detached: '分離',
    ahead: '領先',
    behind: '落後',
    openDiff: '開啟差異',
    tabs: { changes: '變更', log: '記錄', blame: '逐行追溯' } as Record<Page, string>,
    stage: '暫存',
    unstage: '取消暫存',
    discard: '捨棄變更',
    stageAll: '全部暫存',
    unstageAll: '全部取消暫存',
    discardAll: '全部捨棄',
    commitPlaceholder: '提交訊息',
    commit: '提交',
    committed: (sha: string) => `已提交 ${sha}`,
    noCommits: '尚無提交',
    showFiles: '顯示檔案',
    hideFiles: '隱藏檔案',
    noFiles: '沒有檔案變更',
    noBlameFile: '請開啟檔案後執行「Git: Blame File」',
    uncommitted: '尚未提交',
    areas: {
      conflicted: '衝突',
      staged: '已暫存',
      unstaged: '變更',
      untracked: '未追蹤',
    } as Record<ChangeArea, string>,
    codes: {
      M: '已修改',
      A: '已新增',
      D: '已刪除',
      R: '已重新命名',
      C: '已複製',
      T: '類型變更',
      U: '衝突',
      '?': '未追蹤',
    } as Record<string, string>,
  },
})

const AREA_ORDER: ChangeArea[] = ['conflicted', 'staged', 'unstaged', 'untracked']
const PAGES: Page[] = ['changes', 'log']

const root = document.getElementById('root') as HTMLElement
const params = new URLSearchParams(location.search)
let page: Page =
  (['changes', 'log', 'blame'] as Page[]).find((p) => p === params.get('page')) ?? 'changes'
const blameFile = params.get('file') ?? ''
let banner: { text: string; tone: 'error' | 'ok' } | null = null
let draft = ''
const expanded = new Map<string, CommitFile[] | null>()

const relative = new Intl.RelativeTimeFormat(context.locale, { numeric: 'auto' })
const RELATIVE_STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31_536_000],
  ['month', 2_592_000],
  ['week', 604_800],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
]

function relativeTime(seconds: number): string {
  const diff = seconds - Date.now() / 1000
  for (const [unit, size] of RELATIVE_STEPS) {
    if (Math.abs(diff) >= size) return relative.format(Math.round(diff / size), unit)
  }
  return relative.format(Math.round(diff), 'second')
}

function absoluteTime(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString(context.locale)
}

function show(node: Node): void {
  const focused = document.activeElement?.getAttribute('aria-label')
  root.replaceChildren(node)
  if (focused) root.querySelector<HTMLElement>(`[aria-label="${CSS.escape(focused)}"]`)?.focus()
}

function splitPath(path: string): { name: string; dir: string } {
  const slash = path.lastIndexOf('/')
  return slash < 0
    ? { name: path, dir: '' }
    : { name: path.slice(slash + 1), dir: path.slice(0, slash) }
}

function setPage(next: Page): void {
  page = next
  const query = new URLSearchParams(location.search)
  query.set('page', next)
  history.replaceState(null, '', `?${query.toString()}`)
  banner = null
  void refresh()
}

async function act(command: string, args: unknown): Promise<void> {
  const res = await call(command, args)
  banner = res.ok ? null : { text: errorText(res), tone: 'error' }
  if (res.ok && command === 'commit') {
    draft = ''
    banner = {
      text: t.committed(String((res.data as { sha: string }).sha).slice(0, 7)),
      tone: 'ok',
    }
  }
  await refresh()
}

function iconButton(label: string, svg: string, onclick: () => void): HTMLElement {
  return h('button', { class: 'icon', 'aria-label': label, title: label, onclick }, icon(svg))
}

function tabs(): HTMLElement {
  const shown: Page[] = page === 'blame' ? [...PAGES, 'blame'] : PAGES
  return h(
    'nav',
    { class: 'tabs', role: 'tablist' },
    ...shown.map((p) =>
      h(
        'button',
        {
          class: 'tab',
          role: 'tab',
          'aria-selected': p === page ? 'true' : 'false',
          onclick: () => setPage(p),
        },
        t.tabs[p],
      ),
    ),
    h('span', { class: 'spacer' }),
    iconButton(t.refresh, arrowClockwise, () => void refresh()),
  )
}

function bannerView(): HTMLElement | null {
  if (!banner) return null
  return h(
    'div',
    { class: `banner ${banner.tone}`, role: banner.tone === 'error' ? 'alert' : 'status' },
    banner.text,
  )
}

function frame(...body: (HTMLElement | null)[]): HTMLElement {
  return h('main', { class: 'page' }, tabs(), bannerView(), ...body)
}

function absolute(data: { root: string }, path: string): string {
  return `${data.root}/${path}`
}

function changeActions(data: ChangesData, change: FileChange): HTMLElement {
  const path = absolute(data, change.path)
  const buttons: HTMLElement[] = []
  if (change.area === 'unstaged' || change.area === 'untracked') {
    buttons.push(
      iconButton(
        `${t.discard}: ${change.path}`,
        arrowCounterClockwise,
        () => void act('discard', { paths: [path] }),
      ),
    )
  }
  if (change.area === 'staged') {
    buttons.push(
      iconButton(
        `${t.unstage}: ${change.path}`,
        minus,
        () => void act('unstage', { paths: [path] }),
      ),
    )
  } else {
    buttons.push(
      iconButton(`${t.stage}: ${change.path}`, plus, () => void act('stage', { paths: [path] })),
    )
  }
  return h('span', { class: 'actions' }, ...buttons)
}

function changeRow(data: ChangesData, change: FileChange): HTMLElement {
  const { name, dir } = splitPath(change.path)
  const kind = t.codes[change.code] ?? change.code
  return h(
    'li',
    { class: 'row' },
    h(
      'button',
      {
        class: 'change',
        'data-path': change.path,
        'data-area': change.area,
        'aria-label': `${t.openDiff}: ${change.path} (${kind})`,
        title: change.origPath ? `${change.origPath} → ${change.path}` : change.path,
        onclick: () => void act('open', { path: absolute(data, change.path), area: change.area }),
      },
      h('span', { class: `code code-${change.code === '?' ? 'u' : change.code}` }, change.code),
      h('span', { class: 'name' }, name),
      dir ? h('span', { class: 'dir muted' }, dir) : null,
    ),
    changeActions(data, change),
  )
}

function areaActions(area: ChangeArea): HTMLElement | null {
  if (area === 'staged') {
    return h(
      'span',
      { class: 'actions' },
      iconButton(t.unstageAll, minus, () => void act('unstage', { all: true })),
    )
  }
  if (area === 'unstaged' || area === 'untracked') {
    return h(
      'span',
      { class: 'actions' },
      iconButton(
        `${t.discardAll}: ${t.areas[area]}`,
        arrowCounterClockwise,
        () => void act('discard', { all: true }),
      ),
      iconButton(`${t.stageAll}: ${t.areas[area]}`, plus, () => void act('stage', { all: true })),
    )
  }
  return null
}

function branchHeader(data: ChangesData): HTMLElement {
  const b = data.branch
  const bits: string[] = []
  if (b.upstream && b.ahead) bits.push(`↑${b.ahead} ${t.ahead}`)
  if (b.upstream && b.behind) bits.push(`↓${b.behind} ${t.behind}`)
  return h(
    'header',
    { class: 'head' },
    h('span', { class: 'branch' }, b.head ?? `${b.oid?.slice(0, 7) ?? ''} (${t.detached})`),
    b.upstream ? h('span', { class: 'muted' }, b.upstream) : null,
    bits.length ? h('span', { class: 'muted' }, bits.join(' · ')) : null,
  )
}

function commitBox(data: ChangesData): HTMLElement {
  const box = h('textarea', {
    class: 'message',
    rows: '3',
    placeholder: t.commitPlaceholder,
    'aria-label': t.commitPlaceholder,
    oninput: (e) => {
      draft = (e.target as HTMLTextAreaElement).value
      button.toggleAttribute('disabled', !canCommit())
    },
    onkeydown: (e) => {
      const key = e as KeyboardEvent
      if (key.key === 'Enter' && (key.ctrlKey || key.metaKey) && canCommit()) {
        key.preventDefault()
        void act('commit', { message: draft })
      }
    },
  }) as HTMLTextAreaElement
  box.value = draft
  const canCommit = (): boolean => data.counts.staged > 0 && draft.trim().length > 0
  const button = h(
    'button',
    {
      class: 'primary',
      disabled: !canCommit(),
      onclick: () => void act('commit', { message: draft }),
    },
    t.commit,
  )
  return h('section', { class: 'commit' }, box, button)
}

function changesView(data: ChangesData): HTMLElement {
  const sections = AREA_ORDER.map((area) => {
    const items = data.changes.filter((c) => c.area === area)
    if (items.length === 0) return null
    return h(
      'section',
      { class: 'area', 'aria-label': t.areas[area] },
      h(
        'h2',
        {},
        h('span', {}, `${t.areas[area]} `, h('span', { class: 'muted' }, String(items.length))),
        areaActions(area),
      ),
      h('ul', {}, ...items.map((c) => changeRow(data, c))),
    )
  })
  return frame(
    branchHeader(data),
    h('div', { class: 'muted root', title: data.root }, data.root),
    commitBox(data),
    data.changes.length === 0 ? h('div', { class: 'center muted' }, t.clean) : null,
    ...sections,
  )
}

function commitFilesList(sha: string, files: CommitFile[]): HTMLElement {
  if (files.length === 0) return h('div', { class: 'muted files-empty' }, t.noFiles)
  return h(
    'ul',
    { class: 'files' },
    ...files.map((file) => {
      const { name, dir } = splitPath(file.path)
      return h(
        'li',
        {},
        h(
          'button',
          {
            class: 'change',
            'aria-label': `${t.openDiff}: ${file.path} (${sha.slice(0, 7)})`,
            title: file.origPath ? `${file.origPath} → ${file.path}` : file.path,
            onclick: () => void act('openCommitFile', { sha, path: file.path }),
          },
          h('span', { class: `code code-${file.code}` }, file.code),
          h('span', { class: 'name' }, name),
          dir ? h('span', { class: 'dir muted' }, dir) : null,
        ),
      )
    }),
  )
}

async function toggleCommit(sha: string): Promise<void> {
  if (expanded.has(sha)) {
    expanded.delete(sha)
    await refresh()
    return
  }
  expanded.set(sha, null)
  const res = await call('commitFiles', { sha })
  if (res.ok) expanded.set(sha, (res.data as CommitFilesData).files)
  else {
    expanded.delete(sha)
    banner = { text: errorText(res), tone: 'error' }
  }
  await refresh()
}

function logView(data: LogData): HTMLElement {
  if (data.commits.length === 0) {
    return frame(h('div', { class: 'center muted' }, t.noCommits))
  }
  return frame(
    h(
      'ul',
      { class: 'log' },
      ...data.commits.map((c) => {
        const open = expanded.has(c.sha)
        const files = expanded.get(c.sha)
        return h(
          'li',
          { class: 'commit-row' },
          h(
            'button',
            {
              class: 'commit-head',
              'data-sha': c.sha,
              'aria-expanded': open ? 'true' : 'false',
              'aria-label': `${open ? t.hideFiles : t.showFiles}: ${c.sha.slice(0, 7)} ${c.subject}`,
              onclick: () => void toggleCommit(c.sha),
            },
            icon(open ? caretDown : caretRight),
            h('span', { class: 'sha' }, c.sha.slice(0, 7)),
            h('span', { class: 'subject' }, c.subject),
            h('span', { class: 'muted who' }, c.author),
            h('span', { class: 'muted when', title: absoluteTime(c.time) }, relativeTime(c.time)),
          ),
          open && files ? commitFilesList(c.sha, files) : null,
        )
      }),
    ),
  )
}

function blameView(data: BlameData): HTMLElement {
  const rows = data.lines.map((line, i) => {
    const first = i === 0 || data.lines[i - 1].sha !== line.sha
    const pending = /^0+$/.test(line.sha)
    const label = pending
      ? t.uncommitted
      : `${line.sha.slice(0, 7)} ${line.author} · ${relativeTime(line.time)}`
    return h(
      'tr',
      { class: first ? 'blame-first' : '' },
      h(
        'td',
        {
          class: 'blame-who muted',
          title: pending ? t.uncommitted : `${line.summary}\n${absoluteTime(line.time)}`,
        },
        first ? label : '',
      ),
      h('td', { class: 'blame-no muted' }, String(line.line)),
      h('td', { class: 'blame-text' }, line.text),
    )
  })
  return frame(
    h('div', { class: 'muted root', title: `${data.root}/${data.path}` }, data.path),
    h('table', { class: 'blame' }, h('tbody', {}, ...rows)),
  )
}

async function load(): Promise<HTMLElement> {
  if (page === 'blame') {
    if (!blameFile) return frame(h('div', { class: 'center muted' }, t.noBlameFile))
    const res = await call('blame', { path: blameFile })
    return res.ok ? blameView(res.data as BlameData) : failed(res)
  }
  if (page === 'log') {
    const res = await call('log', {})
    return res.ok ? logView(res.data as LogData) : failed(res)
  }
  const res = await call('changes')
  return res.ok ? changesView(res.data as ChangesData) : failed(res)
}

function failed(res: Parameters<typeof errorText>[0]): HTMLElement {
  const notRepo = !res.ok && res.error === 'not-a-repo'
  return frame(
    h(
      'div',
      { class: `center ${notRepo ? 'muted' : 'error'}` },
      notRepo ? t.notRepo : errorText(res),
    ),
  )
}

async function refresh(): Promise<void> {
  show(await load())
}

show(h('div', { class: 'center muted' }, t.loading))
onChange(() => void refresh())
void refresh()
