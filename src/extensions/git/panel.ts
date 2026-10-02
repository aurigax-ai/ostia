import arrowClockwise from '@phosphor-icons/core/regular/arrow-clockwise.svg'
import arrowCounterClockwise from '@phosphor-icons/core/regular/arrow-counter-clockwise.svg'
import arrowDown from '@phosphor-icons/core/regular/arrow-down.svg'
import arrowUp from '@phosphor-icons/core/regular/arrow-up.svg'
import caretDown from '@phosphor-icons/core/regular/caret-down.svg'
import caretRight from '@phosphor-icons/core/regular/caret-right.svg'
import check from '@phosphor-icons/core/regular/check.svg'
import cloud from '@phosphor-icons/core/regular/cloud.svg'
import folderOpen from '@phosphor-icons/core/regular/folder-open.svg'
import folderIcon from '@phosphor-icons/core/regular/folder.svg'
import gitBranch from '@phosphor-icons/core/regular/git-branch.svg'
import listBullets from '@phosphor-icons/core/regular/list-bullets.svg'
import magnifyingGlass from '@phosphor-icons/core/regular/magnifying-glass.svg'
import minus from '@phosphor-icons/core/regular/minus.svg'
import plus from '@phosphor-icons/core/regular/plus.svg'
import tag from '@phosphor-icons/core/regular/tag.svg'
import treeStructure from '@phosphor-icons/core/regular/tree-structure.svg'
import xIcon from '@phosphor-icons/core/regular/x.svg'
import type { ExtensionResult } from '../../shared/extensions'
import { type RelativeStep, formatRelative } from '../../shared/relativeTime'
import {
  call,
  context,
  errorText,
  h,
  icon,
  loadPanelSizes,
  onChange,
  pickLocale,
} from '../sdk/panel'
import { splitter } from '../sdk/splitter'
import { type TreeNode, buildFileTree } from './fileTree'
import { type GraphEdge, type GraphNode, type GraphRow, layoutGraph } from './graph'
import type { BlameLine, CommitFile, CommitRef, CommitSummary, GraphCommit } from './history'
import type { BranchRef, GraphScope } from './scope'
import type { ChangesView } from './settings'
import type { BranchInfo, ChangeArea, FileChange, StatusSummary } from './status'

interface ChangesData {
  root: string
  branch: BranchInfo
  counts: StatusSummary
  changes: FileChange[]
}

interface GraphData extends ChangesData {
  branches: BranchRef[]
  scope: GraphScope
  includesHead: boolean
  commits: GraphCommit[]
  more: boolean
}

interface CommitFilesData {
  root: string
  commit: CommitSummary
  parent: string | null
  files: CommitFile[]
}

interface BlameData {
  root: string
  path: string
  lines: BlameLine[]
}

type Page = 'changes' | 'graph' | 'blame'

const COMMIT_KEYS = /Mac/.test(navigator.platform) ? '⌘Enter' : 'Ctrl+Enter'
type ScopeKind = GraphScope['kind']

const t = pickLocale({
  en: {
    loading: 'Loading…',
    loadingMore: 'Loading more commits…',
    refresh: 'Refresh',
    clean: 'No changes',
    notRepo: 'Not in a git repository',
    notRepoHint: 'Open a terminal inside a repository to see its changes and history.',
    detached: 'detached',
    tabs: { changes: 'Changes', graph: 'Graph', blame: 'Blame' } as Record<Page, string>,
    openDiff: 'Open diff',
    stage: 'Stage',
    unstage: 'Unstage',
    discard: 'Discard changes',
    stageAll: 'Stage all',
    unstageAll: 'Unstage all',
    discardAll: 'Discard all',
    stageFolder: 'Stage folder',
    unstageFolder: 'Unstage folder',
    discardFolder: 'Discard folder',
    commitPlaceholder: 'Commit message',
    commitHint: (keys: string) => `${keys} to commit`,
    commit: 'Commit',
    committed: (sha: string) => `Committed ${sha}`,
    noCommits: 'No commits yet',
    noFiles: 'No file changes',
    noBlameFile: 'Open a file and run Git: Blame File',
    uncommitted: 'Not committed yet',
    viewAs: 'Show changed files as',
    viewList: 'Flat list',
    viewTree: 'Folder tree',
    files: (n: number) => (n === 1 ? '1 file' : `${n} files`),
    upstream: (name: string) => `Tracking ${name}`,
    noUpstream: 'No upstream',
    inSync: 'Up to date',
    aheadBehind: (ahead: number, behind: number, name: string) =>
      `${ahead} to push, ${behind} to pull from ${name}`,
    worktree: 'Uncommitted changes',
    counts: {
      staged: (n: number) => `${n} staged`,
      unstaged: (n: number) => `${n} unstaged`,
      untracked: (n: number) => `${n} untracked`,
      conflicted: (n: number) => (n === 1 ? '1 conflict' : `${n} conflicts`),
    },
    graph: 'Commit graph',
    scope: 'Branches shown',
    scopes: {
      current: 'Current branch',
      all: 'All branches',
      chosen: 'Choose branches',
    } as Record<ScopeKind, string>,
    scopeLabel: (n: number, first: string) => (n === 1 ? first : `${n} branches`),
    scopeAllHint: 'Local and remote',
    filterBranches: 'Filter branches',
    local: 'Local',
    remote: 'Remote',
    noMatch: 'No branches match',
    lastChosen: 'At least one branch stays chosen',
    noBranches: 'No branches yet',
    closeDetails: 'Close details',
    resizeDetails: 'Resize details',
    resizeCommit: 'Resize commit message',
    parents: 'Parents',
    head: 'HEAD',
    merge: 'Merge commit',
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
    loadingMore: '正在載入更多提交…',
    refresh: '重新整理',
    clean: '沒有變更',
    notRepo: '不在 git 儲存庫中',
    notRepoHint: '在儲存庫內開啟終端機，即可查看變更與歷史。',
    detached: '分離',
    tabs: { changes: '變更', graph: '線圖', blame: '逐行追溯' } as Record<Page, string>,
    openDiff: '開啟差異',
    stage: '暫存',
    unstage: '取消暫存',
    discard: '捨棄變更',
    stageAll: '全部暫存',
    unstageAll: '全部取消暫存',
    discardAll: '全部捨棄',
    stageFolder: '暫存資料夾',
    unstageFolder: '取消暫存資料夾',
    discardFolder: '捨棄資料夾',
    commitPlaceholder: '提交訊息',
    commitHint: (keys: string) => `${keys} 提交`,
    commit: '提交',
    committed: (sha: string) => `已提交 ${sha}`,
    noCommits: '尚無提交',
    noFiles: '沒有檔案變更',
    noBlameFile: '請開啟檔案後執行「Git：逐行追溯檔案」',
    uncommitted: '尚未提交',
    viewAs: '變更檔案顯示為',
    viewList: '平面清單',
    viewTree: '資料夾樹',
    files: (n: number) => `${n} 個檔案`,
    upstream: (name: string) => `追蹤 ${name}`,
    noUpstream: '沒有上游分支',
    inSync: '已同步',
    aheadBehind: (ahead: number, behind: number, name: string) =>
      `有 ${ahead} 個待推送、${behind} 個待從 ${name} 拉取`,
    worktree: '未提交的變更',
    counts: {
      staged: (n: number) => `${n} 已暫存`,
      unstaged: (n: number) => `${n} 未暫存`,
      untracked: (n: number) => `${n} 未追蹤`,
      conflicted: (n: number) => `${n} 衝突`,
    },
    graph: '提交線圖',
    scope: '顯示的分支',
    scopes: {
      current: '目前分支',
      all: '所有分支',
      chosen: '選擇分支',
    } as Record<ScopeKind, string>,
    scopeLabel: (n: number, first: string) => (n === 1 ? first : `${n} 個分支`),
    scopeAllHint: '本機與遠端',
    filterBranches: '篩選分支',
    local: '本機',
    remote: '遠端',
    noMatch: '沒有符合的分支',
    lastChosen: '至少要保留一個分支',
    noBranches: '尚無分支',
    closeDetails: '關閉詳細資訊',
    resizeDetails: '調整詳細資訊高度',
    resizeCommit: '調整提交訊息高度',
    parents: '父提交',
    head: 'HEAD',
    merge: '合併提交',
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
const PAGES: Page[] = ['changes', 'graph']
const WORKTREE = 'worktree'
const ROW_HEIGHT = 24
const LANE_WIDTH = 14
const GRAPH_PAD = 8
const MAX_DRAWN_LANES = 12
const OVERSCAN = 8
const GRAPH_PAGE = 300
const LOAD_MORE_MARGIN = 40
const DETAIL_DELAY_MS = 120
const MAX_CACHED_DETAILS = 200
const LANE_COLORS = 8
const SVG_NS = 'http://www.w3.org/2000/svg'
const GRAPH_SPLIT = 'graph-details'
const GRAPH_LIST_FRACTION = 0.55
const GRAPH_MIN_LIST = 96
const DETAIL_MIN = 96
const CHANGES_SPLIT = 'changes-commit'
const FILES_MIN = 72

const root = document.getElementById('root') as HTMLElement
const params = new URLSearchParams(location.search)
let page: Page =
  (['changes', 'graph', 'blame'] as Page[]).find((p) => p === params.get('page')) ?? 'changes'
const blameFile = params.get('file') ?? ''
const sizesReady = loadPanelSizes()

let banner: { text: string; tone: 'error' | 'ok' } | null = null
let draft = ''
let changesView: ChangesView = 'list'
let loaded: { page: Page; data: unknown } | null = null
let failure: ExtensionResult | null = null
let requestSeq = 0
let graphLimit = GRAPH_PAGE
let loadingMore = false
let selected: string | null = null
let scopeOpen = false
let branchQuery = ''
const collapsed = new Set<string>()
const details = new Map<string, CommitFilesData | 'loading' | ExtensionResult>()
let detailTimer: ReturnType<typeof setTimeout> | null = null

const relative = new Intl.RelativeTimeFormat(context.locale, { numeric: 'auto' })
const RELATIVE_STEPS: RelativeStep[] = [
  ['year', 31_536_000],
  ['month', 2_592_000],
  ['week', 604_800],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
  ['second', 1],
]

function relativeTime(seconds: number): string {
  return formatRelative(seconds - Date.now() / 1000, RELATIVE_STEPS, relative)
}

function absoluteTime(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString(context.locale)
}

function focusKey(el: Element | null): string | null {
  if (!el || el === document.body) return null
  return el.getAttribute('data-key') ?? el.getAttribute('aria-label')
}

function show(node: Node): void {
  const key = focusKey(document.activeElement)
  const scrolls = new Map<string, number>()
  for (const el of root.querySelectorAll<HTMLElement>('[data-scroll]')) {
    scrolls.set(el.dataset.scroll ?? '', el.scrollTop)
  }
  root.replaceChildren(node)
  for (const el of root.querySelectorAll<HTMLElement>('[data-scroll]')) {
    const top = scrolls.get(el.dataset.scroll ?? '')
    if (top !== undefined) el.scrollTop = top
  }
  if (!key) return
  const target = [...root.querySelectorAll<HTMLElement>('[data-key], [aria-label]')].find(
    (el) => focusKey(el) === key,
  )
  target?.focus({ preventScroll: true })
  if (target instanceof HTMLInputElement && target.type === 'search') {
    target.setSelectionRange(target.value.length, target.value.length)
  }
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
  scopeOpen = false
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

function iconButton(
  label: string,
  svg: string,
  onclick: () => void,
  extra: Record<string, string> = {},
): HTMLElement {
  return h(
    'button',
    { class: 'icon', 'aria-label': label, title: label, onclick, ...extra },
    icon(svg),
  )
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
          'data-key': `tab-${p}`,
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

function frame(className: string, ...body: (HTMLElement | null)[]): HTMLElement {
  return h('main', { class: `page ${className}` }, tabs(), bannerView(), ...body)
}

function emptyState(title: string, hint?: string, tone: 'muted' | 'error' = 'muted'): HTMLElement {
  return h(
    'div',
    { class: `empty ${tone}`, role: tone === 'error' ? 'alert' : 'status' },
    h('p', { class: 'empty-title' }, title),
    hint ? h('p', { class: 'empty-hint' }, hint) : null,
  )
}

function absolute(data: { root: string }, path: string): string {
  return `${data.root}/${path}`
}

function codeBadge(code: string): HTMLElement {
  const kind = t.codes[code] ?? code
  return h(
    'span',
    { class: `code code-${code === '?' ? 'u' : code}`, title: kind, 'aria-hidden': 'true' },
    code,
  )
}

function viewToggle(): HTMLElement {
  const option = (view: ChangesView, label: string, svg: string): HTMLElement =>
    h(
      'button',
      {
        class: 'icon seg',
        'aria-label': label,
        title: label,
        'aria-pressed': changesView === view ? 'true' : 'false',
        onclick: () => void setChangesView(view),
      },
      icon(svg),
    )
  return h(
    'div',
    { class: 'segmented', role: 'group', 'aria-label': t.viewAs },
    option('list', t.viewList, listBullets),
    option('tree', t.viewTree, treeStructure),
  )
}

async function setChangesView(view: ChangesView): Promise<void> {
  if (view === changesView) return
  changesView = view
  render()
  const res = await call('setChangesView', { view })
  if (!res.ok) banner = { text: errorText(res), tone: 'error' }
  render()
}

function trackingView(branch: BranchInfo): HTMLElement {
  if (!branch.upstream) {
    return h('span', { class: 'tracking muted' }, t.noUpstream)
  }
  const counts: HTMLElement[] = []
  if (branch.ahead) {
    counts.push(h('span', { class: 'count ahead' }, icon(arrowUp), String(branch.ahead)))
  }
  if (branch.behind) {
    counts.push(h('span', { class: 'count behind' }, icon(arrowDown), String(branch.behind)))
  }
  const title =
    counts.length > 0
      ? t.aheadBehind(branch.ahead, branch.behind, branch.upstream)
      : `${t.upstream(branch.upstream)}: ${t.inSync}`
  return h(
    'span',
    { class: 'tracking', title },
    h('span', { class: 'upstream muted' }, icon(cloud), branch.upstream),
    ...(counts.length > 0 ? counts : [h('span', { class: 'count synced' }, icon(check), t.inSync)]),
  )
}

function branchName(branch: BranchInfo): string {
  return branch.head ?? `${branch.oid?.slice(0, 7) ?? ''} (${t.detached})`
}

function rowKeys(e: Event): void {
  const key = (e as KeyboardEvent).key
  if (key !== 'ArrowDown' && key !== 'ArrowUp') return
  const list = e.currentTarget as HTMLElement
  const rows = [...list.querySelectorAll<HTMLElement>('button.change, button.folder')]
  const at = rows.indexOf(document.activeElement as HTMLElement)
  const next = rows[at + (key === 'ArrowDown' ? 1 : -1)]
  if (next) {
    e.preventDefault()
    next.focus()
  }
}

interface FileActions<T> {
  open: (item: T) => void
  label: (item: T) => string
  actions?: (items: T[], folder: string | null) => HTMLElement | null
}

function fileButton<T extends { path: string; code: string; origPath?: string }>(
  item: T,
  depth: number | null,
  handlers: FileActions<T>,
): HTMLElement {
  const { name, dir } = splitPath(item.path)
  const button = h(
    'button',
    {
      class: 'change',
      'data-path': item.path,
      'aria-label': handlers.label(item),
      title: item.origPath ? `${item.origPath} → ${item.path}` : item.path,
      onclick: () => handlers.open(item),
    },
    codeBadge(item.code),
    h('span', { class: 'name' }, name),
    depth === null && dir ? h('span', { class: 'dir muted' }, dir) : null,
  )
  if (depth !== null) button.style.paddingLeft = `${indent(depth) + 16}px`
  return button
}

function indent(depth: number): number {
  return 10 + depth * 12
}

function fileRow<T extends { path: string; code: string; origPath?: string }>(
  item: T,
  depth: number | null,
  handlers: FileActions<T>,
  area: string,
): HTMLElement {
  return h(
    'li',
    { class: 'row', 'data-area': area },
    fileButton(item, depth, handlers),
    handlers.actions?.([item], null) ?? null,
  )
}

function leaves<T>(node: TreeNode<T>): T[] {
  return node.kind === 'file' ? [node.item] : node.children.flatMap(leaves)
}

function treeRows<T extends { path: string; code: string; origPath?: string }>(
  nodes: TreeNode<T>[],
  depth: number,
  scopeKey: string,
  handlers: FileActions<T>,
): HTMLElement[] {
  return nodes.flatMap((node) => {
    if (node.kind === 'file') return [fileRow(node.item, depth, handlers, scopeKey)]
    const key = `${scopeKey}:${node.path}`
    const open = !collapsed.has(key)
    const toggle = (want: boolean): void => {
      if (want === open) return
      if (want) collapsed.delete(key)
      else collapsed.add(key)
      render()
    }
    const button = h(
      'button',
      {
        class: 'folder',
        'data-key': `folder-${key}`,
        'aria-expanded': open ? 'true' : 'false',
        title: node.path,
        onclick: () => toggle(!open),
        onkeydown: (e) => {
          const k = (e as KeyboardEvent).key
          if (k === 'ArrowRight' || k === 'ArrowLeft') {
            e.preventDefault()
            toggle(k === 'ArrowRight')
          }
        },
      },
      h('span', { class: 'caret' }, icon(open ? caretDown : caretRight)),
      h('span', { class: 'folder-icon' }, icon(open ? folderOpen : folderIcon)),
      h('span', { class: 'name' }, node.name),
      h('span', { class: 'folder-count', title: t.files(node.count) }, String(node.count)),
    )
    button.style.paddingLeft = `${indent(depth)}px`
    const row = h(
      'li',
      { class: 'row folder-row' },
      button,
      handlers.actions?.(leaves(node), node.path) ?? null,
    )
    return open ? [row, ...treeRows(node.children, depth + 1, scopeKey, handlers)] : [row]
  })
}

function fileList<T extends { path: string; code: string; origPath?: string }>(
  items: T[],
  scopeKey: string,
  handlers: FileActions<T>,
): HTMLElement {
  const rows =
    changesView === 'tree'
      ? treeRows(buildFileTree(items), 0, scopeKey, handlers)
      : items.map((item) => fileRow(item, null, handlers, scopeKey))
  return h('ul', { class: 'files', onkeydown: rowKeys }, ...rows)
}

function changeActions(data: ChangesData, area: ChangeArea) {
  return (items: FileChange[], folder: string | null): HTMLElement => {
    const paths = items.map((c) => absolute(data, c.path))
    const what = folder ?? items[0]?.path ?? ''
    const buttons: HTMLElement[] = []
    if (area === 'unstaged' || area === 'untracked') {
      buttons.push(
        iconButton(
          `${folder ? t.discardFolder : t.discard}: ${what}`,
          arrowCounterClockwise,
          () => void act('discard', { paths }),
        ),
      )
    }
    if (area === 'staged') {
      buttons.push(
        iconButton(
          `${folder ? t.unstageFolder : t.unstage}: ${what}`,
          minus,
          () => void act('unstage', { paths }),
        ),
      )
    } else {
      buttons.push(
        iconButton(
          `${folder ? t.stageFolder : t.stage}: ${what}`,
          plus,
          () => void act('stage', { paths }),
        ),
      )
    }
    return h('span', { class: 'actions' }, ...buttons)
  }
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

function changeSections(data: ChangesData, keyPrefix: string): HTMLElement[] {
  return AREA_ORDER.flatMap((area) => {
    const items = data.changes.filter((c) => c.area === area)
    if (items.length === 0) return []
    const handlers: FileActions<FileChange> = {
      open: (c) => void act('open', { path: absolute(data, c.path), area: c.area }),
      label: (c) => `${t.openDiff}: ${c.path} (${t.codes[c.code] ?? c.code})`,
      actions: changeActions(data, area),
    }
    return [
      h(
        'section',
        { class: `area area-${area}`, 'aria-label': t.areas[area] },
        h(
          'h2',
          {},
          h('span', { class: 'area-title' }, t.areas[area]),
          h('span', { class: 'area-count' }, String(items.length)),
          h('span', { class: 'spacer' }),
          areaActions(area),
        ),
        fileList(items, `${keyPrefix}${area}`, handlers),
      ),
    ]
  })
}

function branchHeader(data: ChangesData): HTMLElement {
  return h(
    'header',
    { class: 'head' },
    h('span', { class: 'branch' }, icon(gitBranch), branchName(data.branch)),
    trackingView(data.branch),
    h('span', { class: 'spacer' }),
    viewToggle(),
  )
}

function commitBox(data: ChangesData): HTMLElement {
  const box = h('textarea', {
    class: 'message',
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
  return h(
    'section',
    { class: 'commit' },
    box,
    h(
      'div',
      { class: 'commit-bar' },
      h('span', { class: 'muted hint' }, t.commitHint(COMMIT_KEYS)),
      button,
    ),
  )
}

function changesPage(data: ChangesData): HTMLElement {
  const top = h(
    'div',
    { class: 'changes-top' },
    branchHeader(data),
    h('div', { class: 'muted root', title: data.root }, data.root),
    commitBox(data),
  )
  const files = h(
    'div',
    { class: 'changes-files', 'data-scroll': 'changes' },
    data.changes.length === 0 ? emptyState(t.clean) : null,
    ...changeSections(data, ''),
  )
  return frame(
    'changes-page',
    splitter({
      key: CHANGES_SPLIT,
      label: t.resizeCommit,
      first: top,
      second: files,
      defaultFraction: 0,
      minFirst: 0,
      minSecond: FILES_MIN,
    }),
  )
}

function svg(tag: string, attrs: Record<string, string | number>): SVGElement {
  const el = document.createElementNS(SVG_NS, tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v))
  return el
}

function laneX(lane: number): number {
  return GRAPH_PAD + lane * LANE_WIDTH + LANE_WIDTH / 2
}

function edgePath(e: GraphEdge, y1: number, y2: number): SVGElement {
  const x1 = laneX(e.from)
  const x2 = laneX(e.to)
  const d = x1 === x2 ? `M${x1} ${y1}V${y2}` : `M${x1} ${y1}C${x1} ${y2} ${x2} ${y1} ${x2} ${y2}`
  return svg('path', {
    d,
    class: `edge lane-${e.color % LANE_COLORS}${e.pending ? ' pending' : ''}`,
  })
}

type Entry = { kind: 'worktree' } | { kind: 'commit'; commit: GraphCommit }

interface GraphModel {
  data: GraphData
  entries: Entry[]
  rows: GraphRow[]
  width: number
}

let model: GraphModel | null = null
let graphResize: ResizeObserver | null = null

function entryKey(entry: Entry): string {
  return entry.kind === 'worktree' ? WORKTREE : entry.commit.sha
}

function buildModel(data: GraphData): GraphModel {
  const dirty = data.changes.length > 0
  const entries: Entry[] = [
    ...(dirty ? [{ kind: 'worktree' } as Entry] : []),
    ...data.commits.map((commit): Entry => ({ kind: 'commit', commit })),
  ]
  const head = data.branch.oid
  const nodes: GraphNode[] = entries.map((entry) =>
    entry.kind === 'worktree'
      ? { sha: WORKTREE, parents: head && data.includesHead ? [head] : [], pending: true }
      : { sha: entry.commit.sha, parents: entry.commit.parents },
  )
  const rows = layoutGraph(nodes)
  const lanes = Math.min(MAX_DRAWN_LANES, Math.max(1, ...rows.map((r) => r.width)))
  return { data, entries, rows, width: GRAPH_PAD * 2 + lanes * LANE_WIDTH }
}

function nodeMark(entry: Entry, row: GraphRow, isHead: boolean): SVGElement {
  const cx = laneX(row.lane)
  const cy = ROW_HEIGHT / 2
  const lane = `lane-${row.color % LANE_COLORS}`
  if (entry.kind === 'worktree') {
    return svg('circle', { cx, cy, r: 4.5, class: `node pending ${lane}` })
  }
  if (isHead) {
    const g = svg('g', {})
    g.append(
      svg('circle', { cx, cy, r: 5, class: `node ring ${lane}` }),
      svg('circle', { cx, cy, r: 2, class: `node ${lane}` }),
    )
    return g
  }
  if (entry.commit.parents.length > 1) {
    return svg('circle', { cx, cy, r: 3, class: `node merge ${lane}` })
  }
  return svg('circle', { cx, cy, r: 4, class: `node ${lane}` })
}

function graphSvg(entry: Entry, row: GraphRow, isHead: boolean, width: number): SVGElement {
  const el = svg('svg', {
    class: 'lanes',
    width,
    height: ROW_HEIGHT,
    viewBox: `0 0 ${width} ${ROW_HEIGHT}`,
    'aria-hidden': 'true',
  })
  const mid = ROW_HEIGHT / 2
  for (const e of row.top) el.append(edgePath(e, 0, mid))
  for (const e of row.bottom) el.append(edgePath(e, mid, ROW_HEIGHT))
  el.append(nodeMark(entry, row, isHead))
  return el
}

function refBadge(ref: CommitRef, color: number): HTMLElement {
  const glyph = ref.kind === 'tag' ? tag : ref.kind === 'remote' ? cloud : gitBranch
  return h(
    'span',
    {
      class: `ref ref-${ref.kind}${ref.current ? ' ref-current' : ''}${ref.current || ref.kind === 'head' ? ` lane-${color % LANE_COLORS}` : ''}`,
      title: ref.current ? `${t.head} → ${ref.name}` : ref.name,
    },
    icon(glyph),
    h('span', { class: 'ref-name' }, ref.name),
  )
}

function countChips(counts: StatusSummary): HTMLElement[] {
  const chips: HTMLElement[] = []
  if (counts.conflicted) {
    chips.push(h('span', { class: 'wt-count conflicted' }, t.counts.conflicted(counts.conflicted)))
  }
  if (counts.staged)
    chips.push(h('span', { class: 'wt-count staged' }, t.counts.staged(counts.staged)))
  if (counts.unstaged) {
    chips.push(h('span', { class: 'wt-count unstaged' }, t.counts.unstaged(counts.unstaged)))
  }
  if (counts.untracked) {
    chips.push(h('span', { class: 'wt-count untracked' }, t.counts.untracked(counts.untracked)))
  }
  return chips
}

function graphRow(m: GraphModel, index: number): HTMLElement {
  const entry = m.entries[index]
  const row = m.rows[index]
  const key = entryKey(entry)
  const isSelected = key === selected
  const isHead = entry.kind === 'commit' && entry.commit.sha === m.data.branch.oid
  const body: (HTMLElement | null)[] =
    entry.kind === 'worktree'
      ? [
          h('span', { class: 'subject worktree-title' }, t.worktree),
          h('span', { class: 'wt-counts' }, ...countChips(m.data.counts)),
        ]
      : [
          h(
            'span',
            { class: 'refs' },
            ...(isHead && !entry.commit.refs.some((r) => r.current || r.kind === 'head')
              ? [refBadge({ kind: 'head', name: t.head }, row.color)]
              : []),
            ...entry.commit.refs.map((ref) => refBadge(ref, row.color)),
          ),
          h('span', { class: 'subject', title: entry.commit.subject }, entry.commit.subject),
          h('span', { class: 'who muted' }, entry.commit.author),
          h(
            'span',
            { class: 'when muted', title: absoluteTime(entry.commit.time) },
            relativeTime(entry.commit.time),
          ),
          h('span', { class: 'sha muted' }, entry.commit.sha.slice(0, 7)),
        ]
  const el = h(
    'div',
    {
      class: `graph-row${isSelected ? ' selected' : ''}${entry.kind === 'worktree' ? ' worktree' : ''}`,
      role: 'option',
      id: `row-${key}`,
      'data-row': key,
      'aria-selected': isSelected ? 'true' : 'false',
      onclick: () => select(key),
    },
    h('span', { class: 'lanes-cell' }, graphSvg(entry, row, isHead, m.width)),
    ...body,
  )
  el.style.transform = `translateY(${index * ROW_HEIGHT}px)`
  return el
}

function paintRows(scroller: HTMLElement, canvas: HTMLElement): void {
  const m = model
  if (!m) return
  const first = Math.max(0, Math.floor(scroller.scrollTop / ROW_HEIGHT) - OVERSCAN)
  const visible = Math.ceil((scroller.clientHeight || ROW_HEIGHT * 20) / ROW_HEIGHT)
  const last = Math.min(m.entries.length, first + visible + OVERSCAN * 2)
  const rows: HTMLElement[] = []
  for (let i = first; i < last; i++) rows.push(graphRow(m, i))
  if (loadingMore) {
    const more = h('div', { class: 'graph-more muted', role: 'status' }, t.loadingMore)
    more.style.transform = `translateY(${m.entries.length * ROW_HEIGHT}px)`
    rows.push(more)
  }
  canvas.replaceChildren(...rows)
  if (m.data.more && !loadingMore && last >= m.entries.length - LOAD_MORE_MARGIN) {
    void loadMore()
  }
}

async function loadMore(): Promise<void> {
  loadingMore = true
  graphLimit += GRAPH_PAGE
  render()
  await refresh()
  loadingMore = false
  render()
}

function indexOfKey(m: GraphModel, key: string | null): number {
  return key === null ? -1 : m.entries.findIndex((e) => entryKey(e) === key)
}

function select(key: string | null): void {
  selected = key
  if (key && key !== WORKTREE && !details.has(key)) {
    details.set(key, 'loading')
    if (detailTimer) clearTimeout(detailTimer)
    detailTimer = setTimeout(() => void loadDetail(key), DETAIL_DELAY_MS)
  }
  render()
}

async function loadDetail(sha: string): Promise<void> {
  const res = await call('commitFiles', { sha })
  details.set(sha, res.ok ? (res.data as CommitFilesData) : res)
  while (details.size > MAX_CACHED_DETAILS) {
    const oldest = details.keys().next().value
    if (oldest === undefined) break
    details.delete(oldest)
  }
  if (selected === sha) render()
}

function moveSelection(scroller: HTMLElement, key: string): void {
  const m = model
  if (!m || m.entries.length === 0) return
  const at = indexOfKey(m, selected)
  const page = Math.max(1, Math.floor(scroller.clientHeight / ROW_HEIGHT) - 1)
  const moves: Record<string, number> = {
    ArrowDown: at + 1,
    ArrowUp: Math.max(0, at - 1),
    PageDown: at + page,
    PageUp: Math.max(0, at - page),
    Home: 0,
    End: m.entries.length - 1,
  }
  const next = Math.min(m.entries.length - 1, Math.max(0, moves[key]))
  const top = next * ROW_HEIGHT
  if (top < scroller.scrollTop) scroller.scrollTop = top
  else if (top + ROW_HEIGHT > scroller.scrollTop + scroller.clientHeight) {
    scroller.scrollTop = top + ROW_HEIGHT - scroller.clientHeight
  }
  select(entryKey(m.entries[next]))
}

function graphList(m: GraphModel): HTMLElement {
  const canvas = h('div', { class: 'graph-canvas' })
  canvas.style.height = `${(m.entries.length + (loadingMore ? 1 : 0)) * ROW_HEIGHT}px`
  const active = indexOfKey(m, selected)
  const scroller = h('div', {
    class: 'graph-scroll',
    role: 'listbox',
    tabindex: '0',
    'aria-label': t.graph,
    'data-scroll': 'graph',
    ...(active >= 0 ? { 'aria-activedescendant': `row-${selected}` } : {}),
    onkeydown: (e) => {
      const key = (e as KeyboardEvent).key
      if (key === 'Escape' && selected) {
        e.preventDefault()
        select(null)
        return
      }
      if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End'].includes(key)) {
        e.preventDefault()
        moveSelection(e.currentTarget as HTMLElement, key)
      }
    },
  })
  scroller.style.setProperty('--graph-width', `${m.width}px`)
  scroller.append(canvas)
  let frame = 0
  scroller.addEventListener('scroll', () => {
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      paintRows(scroller, canvas)
    })
  })
  graphResize?.disconnect()
  graphResize = new ResizeObserver(() => paintRows(scroller, canvas))
  graphResize.observe(scroller)
  return scroller
}

function scopeLabel(data: GraphData): string {
  const scope = data.scope
  if (scope.kind !== 'chosen') return t.scopes[scope.kind]
  const first = data.branches.find((b) => b.ref === scope.refs[0])?.name ?? scope.refs[0]
  return t.scopeLabel(scope.refs.length, first)
}

async function setScope(scope: GraphScope): Promise<void> {
  graphLimit = GRAPH_PAGE
  selected = null
  const res = await call('setScope', { scope })
  if (!res.ok) banner = { text: errorText(res), tone: 'error' }
  for (const el of root.querySelectorAll<HTMLElement>('[data-scroll="graph"]')) el.scrollTop = 0
  await refresh()
}

function scopeOption(data: GraphData, kind: ScopeKind, hint: string | null): HTMLElement {
  const current = data.branches.find((b) => b.current)
  const disabled = kind === 'chosen' && data.branches.length === 0
  return h(
    'label',
    { class: `scope-option${disabled ? ' disabled' : ''}` },
    h('input', {
      type: 'radio',
      name: 'scope',
      value: kind,
      'data-key': `scope-${kind}`,
      checked: data.scope.kind === kind,
      disabled,
      onchange: () => {
        if (kind === 'chosen') {
          const ref = current?.ref ?? data.branches[0]?.ref
          if (ref) void setScope({ kind: 'chosen', refs: [ref] })
        } else void setScope({ kind })
      },
    }),
    h('span', { class: 'scope-option-label' }, t.scopes[kind]),
    hint ? h('span', { class: 'muted scope-hint' }, hint) : null,
  )
}

function branchChoices(data: GraphData): HTMLElement {
  const chosen = data.scope.kind === 'chosen' ? data.scope.refs : []
  const query = branchQuery.trim().toLowerCase()
  const matches = data.branches.filter((b) => !query || b.name.toLowerCase().includes(query))
  const group = (label: string, list: BranchRef[]): HTMLElement | null => {
    if (list.length === 0) return null
    return h(
      'div',
      { class: 'branch-group', role: 'group', 'aria-label': label },
      h('div', { class: 'branch-group-title' }, label),
      ...list.map((b) => {
        const on = chosen.includes(b.ref)
        const last = on && chosen.length === 1
        return h(
          'label',
          { class: 'branch-choice', title: last ? t.lastChosen : b.ref },
          h('input', {
            type: 'checkbox',
            'data-key': `branch-${b.ref}`,
            checked: on,
            disabled: last,
            onchange: () => {
              const refs = on ? chosen.filter((r) => r !== b.ref) : [...chosen, b.ref]
              void setScope({ kind: 'chosen', refs })
            },
          }),
          h('span', { class: 'branch-choice-name' }, b.name),
          b.current ? h('span', { class: 'muted scope-hint' }, t.head) : null,
        )
      }),
    )
  }
  const search = h('input', {
    type: 'search',
    class: 'branch-search',
    placeholder: t.filterBranches,
    'aria-label': t.filterBranches,
    oninput: (e) => {
      branchQuery = (e.target as HTMLInputElement).value
      render()
    },
  }) as HTMLInputElement
  search.value = branchQuery
  const groups = [
    group(
      t.local,
      matches.filter((b) => !b.remote),
    ),
    group(
      t.remote,
      matches.filter((b) => b.remote),
    ),
  ].filter((g): g is HTMLElement => g !== null)
  return h(
    'div',
    { class: 'branch-picker' },
    h('div', { class: 'search-box' }, icon(magnifyingGlass), search),
    h(
      'div',
      { class: 'branch-list', 'data-scroll': 'branches' },
      ...(groups.length > 0 ? groups : [h('div', { class: 'muted branch-empty' }, t.noMatch)]),
    ),
  )
}

function closeScope(focusTrigger: boolean): void {
  scopeOpen = false
  render()
  if (focusTrigger) root.querySelector<HTMLElement>('.scope-trigger')?.focus()
}

function scopeControl(data: GraphData): HTMLElement {
  const current = data.branches.find((b) => b.current)
  const trigger = h(
    'button',
    {
      class: 'scope-trigger',
      'data-key': 'scope-trigger',
      'aria-haspopup': 'dialog',
      'aria-expanded': scopeOpen ? 'true' : 'false',
      title: t.scope,
      onclick: () => {
        scopeOpen = !scopeOpen
        render()
        if (scopeOpen) {
          root.querySelector<HTMLElement>('.scope-menu input[type="radio"]:checked')?.focus()
        }
      },
    },
    icon(gitBranch),
    h('span', { class: 'scope-trigger-label' }, scopeLabel(data)),
    icon(caretDown),
  )
  const menu = scopeOpen
    ? h(
        'div',
        {
          class: 'scope-menu',
          role: 'dialog',
          'aria-label': t.scope,
          onkeydown: (e) => {
            if ((e as KeyboardEvent).key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              closeScope(true)
            }
          },
        },
        h(
          'fieldset',
          { class: 'scope-kinds' },
          h('legend', { class: 'sr-only' }, t.scope),
          scopeOption(data, 'current', current?.name ?? null),
          scopeOption(data, 'all', t.scopeAllHint),
          scopeOption(data, 'chosen', data.branches.length === 0 ? t.noBranches : null),
        ),
        data.scope.kind === 'chosen' ? branchChoices(data) : null,
      )
    : null
  return h('div', { class: 'scope' }, trigger, menu)
}

function graphToolbar(data: GraphData): HTMLElement {
  return h(
    'div',
    { class: 'graph-toolbar' },
    scopeControl(data),
    h('span', { class: 'toolbar-branch' }, icon(gitBranch), branchName(data.branch)),
    trackingView(data.branch),
  )
}

function detailHeader(title: HTMLElement, ...meta: (HTMLElement | null)[]): HTMLElement {
  return h(
    'header',
    { class: 'detail-head' },
    h('div', { class: 'detail-title' }, title, h('div', { class: 'detail-meta muted' }, ...meta)),
    viewToggle(),
    iconButton(t.closeDetails, xIcon, () => select(null)),
  )
}

function worktreeDetail(data: GraphData): HTMLElement {
  return h(
    'section',
    { class: 'detail', 'aria-label': t.worktree, 'data-scroll': 'detail' },
    detailHeader(
      h('span', { class: 'detail-subject' }, t.worktree),
      h('span', { class: 'wt-counts' }, ...countChips(data.counts)),
    ),
    ...changeSections(data, 'wt-'),
  )
}

function commitDetailView(m: GraphModel, commit: GraphCommit): HTMLElement {
  const state = details.get(commit.sha)
  const parentLinks = commit.parents.map((p) =>
    h(
      'button',
      {
        class: 'link sha',
        'aria-label': `${t.parents}: ${p.slice(0, 7)}`,
        disabled: indexOfKey(m, p) < 0,
        onclick: () => select(p),
      },
      p.slice(0, 7),
    ),
  )
  let body: HTMLElement
  if (state === undefined || state === 'loading') {
    body = h('div', { class: 'muted detail-status', role: 'status' }, t.loading)
  } else if ('ok' in state) {
    body = h('div', { class: 'error detail-status', role: 'alert' }, errorText(state))
  } else if (state.files.length === 0) {
    body = h('div', { class: 'muted detail-status' }, t.noFiles)
  } else {
    body = fileList(state.files, `c-${commit.sha}`, {
      open: (f) => void act('openCommitFile', { sha: commit.sha, path: f.path }),
      label: (f) => `${t.openDiff}: ${f.path} (${commit.sha.slice(0, 7)})`,
    })
  }
  return h(
    'section',
    { class: 'detail', 'aria-label': commit.subject, 'data-scroll': 'detail' },
    detailHeader(
      h('span', { class: 'detail-subject' }, commit.subject),
      h('span', { class: 'sha' }, commit.sha.slice(0, 10)),
      h('span', {}, commit.author),
      h('span', { title: absoluteTime(commit.time) }, relativeTime(commit.time)),
      commit.parents.length > 1 ? h('span', {}, t.merge) : null,
      parentLinks.length > 0
        ? h('span', { class: 'parents' }, `${t.parents}: `, ...parentLinks)
        : null,
    ),
    body,
  )
}

function graphView(data: GraphData): HTMLElement {
  if (!model || model.data !== data) model = buildModel(data)
  const m = model
  if (m.entries.length === 0) {
    return frame('graph-page', graphToolbar(data), emptyState(t.noCommits))
  }
  if (selected && indexOfKey(m, selected) < 0) selected = null
  const entry = selected ? m.entries[indexOfKey(m, selected)] : null
  const detail = !entry
    ? null
    : entry.kind === 'worktree'
      ? worktreeDetail(data)
      : commitDetailView(m, entry.commit)
  const list = graphList(m)
  const body = detail
    ? splitter({
        key: GRAPH_SPLIT,
        label: t.resizeDetails,
        first: list,
        second: detail,
        defaultFraction: GRAPH_LIST_FRACTION,
        minFirst: GRAPH_MIN_LIST,
        minSecond: DETAIL_MIN,
        collapseSecond: true,
      })
    : list
  return frame('graph-page', graphToolbar(data), body)
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
    'blame-page',
    h('div', { class: 'muted root', title: `${data.root}/${data.path}` }, data.path),
    h('table', { class: 'blame' }, h('tbody', {}, ...rows)),
  )
}

function failedView(res: ExtensionResult): HTMLElement {
  const notRepo = !res.ok && res.error === 'not-a-repo'
  return frame(
    'failed-page',
    notRepo ? emptyState(t.notRepo, t.notRepoHint) : emptyState(errorText(res), undefined, 'error'),
  )
}

function view(): HTMLElement {
  if (failure) return failedView(failure)
  if (page === 'blame' && !blameFile) return frame('blame-page', emptyState(t.noBlameFile))
  if (!loaded || loaded.page !== page) {
    return frame('loading-page', h('div', { class: 'empty muted', role: 'status' }, t.loading))
  }
  if (page === 'blame') return blameView(loaded.data as BlameData)
  if (page === 'graph') return graphView(loaded.data as GraphData)
  return changesPage(loaded.data as ChangesData)
}

function render(): void {
  show(view())
}

async function fetchPage(): Promise<{ page: Page; res: ExtensionResult }> {
  const current = page
  if (current === 'blame') {
    return { page: current, res: await call('blame', { path: blameFile }) }
  }
  if (current === 'graph') return { page: current, res: await call('graph', { limit: graphLimit }) }
  return { page: current, res: await call('changes') }
}

async function refresh(): Promise<void> {
  const seq = ++requestSeq
  if (page === 'blame' && !blameFile) {
    render()
    return
  }
  const [viewRes, { page: fetched, res }] = await Promise.all([
    call('view'),
    fetchPage(),
    sizesReady,
  ])
  if (seq !== requestSeq || fetched !== page) return
  if (viewRes.ok) changesView = (viewRes.data as { changesView: ChangesView }).changesView
  failure = res.ok ? null : res
  if (res.ok) loaded = { page: fetched, data: res.data }
  render()
}

document.addEventListener('mousedown', (e) => {
  if (!scopeOpen) return
  if ((e.target as Element | null)?.closest('.scope')) return
  closeScope(false)
})

render()
onChange(() => void refresh())
void refresh()
