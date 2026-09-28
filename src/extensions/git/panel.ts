import { call, errorText, h, onChange, pickLocale } from '../sdk/panel'
import type { BranchInfo, ChangeArea, FileChange, StatusSummary } from './status'

interface ChangesData {
  root: string
  branch: BranchInfo
  counts: StatusSummary
  changes: FileChange[]
}

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

const root = document.getElementById('root') as HTMLElement
let banner: string | null = null

function show(node: Node): void {
  root.replaceChildren(node)
}

function splitPath(path: string): { name: string; dir: string } {
  const slash = path.lastIndexOf('/')
  return slash < 0
    ? { name: path, dir: '' }
    : { name: path.slice(slash + 1), dir: path.slice(0, slash) }
}

async function openDiff(data: ChangesData, change: FileChange): Promise<void> {
  const res = await call('open', { path: `${data.root}/${change.path}`, area: change.area })
  banner = res.ok ? null : errorText(res)
  await refresh()
}

function row(data: ChangesData, change: FileChange): HTMLElement {
  const { name, dir } = splitPath(change.path)
  const kind = t.codes[change.code] ?? change.code
  const label = `${t.openDiff}: ${change.path} (${kind})`
  return h(
    'li',
    {},
    h(
      'button',
      {
        class: 'change',
        'data-path': change.path,
        'data-area': change.area,
        'aria-label': label,
        title: change.origPath ? `${change.origPath} → ${change.path}` : change.path,
        onclick: () => void openDiff(data, change),
      },
      h('span', { class: `code code-${change.code === '?' ? 'u' : change.code}` }, change.code),
      h('span', { class: 'name' }, name),
      dir ? h('span', { class: 'dir muted' }, dir) : null,
    ),
  )
}

function header(data: ChangesData): HTMLElement {
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
    h('span', { class: 'spacer' }),
    h(
      'button',
      { class: 'icon', 'aria-label': t.refresh, title: t.refresh, onclick: refresh },
      '↻',
    ),
  )
}

function view(data: ChangesData): HTMLElement {
  const sections = AREA_ORDER.map((area) => {
    const items = data.changes.filter((c) => c.area === area)
    if (items.length === 0) return null
    return h(
      'section',
      { class: 'area', 'aria-label': t.areas[area] },
      h('h2', {}, `${t.areas[area]} `, h('span', { class: 'muted' }, String(items.length))),
      h('ul', {}, ...items.map((c) => row(data, c))),
    )
  })
  return h(
    'main',
    { class: 'changes' },
    header(data),
    banner ? h('div', { class: 'banner error', role: 'alert' }, banner) : null,
    h('div', { class: 'muted root', title: data.root }, data.root),
    data.changes.length === 0 ? h('div', { class: 'center muted' }, t.clean) : null,
    ...sections,
  )
}

async function refresh(): Promise<void> {
  const res = await call('changes')
  if (!res.ok) {
    const text = res.error === 'not-a-repo' ? t.notRepo : errorText(res)
    show(h('div', { class: `center ${res.error === 'not-a-repo' ? 'muted' : 'error'}` }, text))
    return
  }
  const focused = document.activeElement?.getAttribute('aria-label')
  show(view(res.data as ChangesData))
  if (focused) root.querySelector<HTMLElement>(`[aria-label="${CSS.escape(focused)}"]`)?.focus()
}

show(h('div', { class: 'center muted' }, t.loading))
onChange(() => void refresh())
void refresh()
