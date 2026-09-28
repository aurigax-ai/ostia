import { call, errorText, h, onChange, pickLocale } from '../sdk/panel'

type Scope = 'project' | 'global'

interface Summary {
  slug: string
  title: string
}

interface Page {
  slug: string
  title: string
  body: string
}

const t = pickLocale({
  en: {
    scope: 'Wiki scope',
    project: 'Project',
    global: 'Global',
    noPages: 'No pages yet',
    selectOrCreate: 'Select or create a page',
    newSlug: 'New page slug',
    newSlugPlaceholder: 'new-page-slug',
    create: 'Create page',
    pageTitle: 'Page title',
    pageBody: 'Page body',
    edit: 'Edit',
    cancel: 'Cancel',
    save: 'Save',
  },
  'zh-Hant': {
    scope: 'Wiki 範圍',
    project: '專案',
    global: '全域',
    noPages: '尚無頁面',
    selectOrCreate: '選擇或建立頁面',
    newSlug: '新頁面代稱',
    newSlugPlaceholder: 'new-page-slug',
    create: '建立頁面',
    pageTitle: '頁面標題',
    pageBody: '頁面內容',
    edit: '編輯',
    cancel: '取消',
    save: '儲存',
  },
})

const state: {
  scope: Scope
  pages: Summary[]
  selected: string | null
  page: Page | null
  editing: boolean
  error: string
} = { scope: 'project', pages: [], selected: null, page: null, editing: false, error: '' }

const root = document.getElementById('root') as HTMLElement

function inline(line: string): (Node | string)[] {
  const parts: (Node | string)[] = []
  let last = 0
  for (const m of line.matchAll(/`([^`]+)`|\*\*([^*]+)\*\*/g)) {
    if (m.index === undefined) continue
    if (m.index > last) parts.push(line.slice(last, m.index))
    parts.push(m[1] !== undefined ? h('code', {}, m[1]) : h('strong', {}, m[2] ?? ''))
    last = m.index + m[0].length
  }
  if (last < line.length) parts.push(line.slice(last))
  return parts
}

function renderBody(body: string): HTMLElement {
  const out = h('div', { class: 'page-body' })
  let list: HTMLElement | null = null
  for (const line of body.split('\n')) {
    const bullet = /^[-*]\s+(.*)$/.exec(line)
    if (bullet) {
      list ??= out.appendChild(h('ul'))
      list.append(h('li', {}, ...inline(bullet[1])))
      continue
    }
    list = null
    const heading = /^(#{1,3})\s+(.*)$/.exec(line)
    if (heading) out.append(h(`h${heading[1].length + 1}`, {}, ...inline(heading[2])))
    else if (line.trim() === '') out.append(h('div', { class: 'gap' }))
    else out.append(h('p', {}, ...inline(line)))
  }
  return out
}

async function loadList(): Promise<void> {
  const res = await call('ls', { scope: state.scope })
  state.pages = res.ok ? ((res.data as { pages: Summary[] }).pages ?? []) : []
  state.error = res.ok ? '' : errorText(res)
}

async function loadPage(): Promise<void> {
  if (!state.selected) {
    state.page = null
    return
  }
  const res = await call('get', { slug: state.selected, scope: state.scope })
  state.page = res.ok ? (res.data as Page) : null
  state.error = res.ok ? '' : errorText(res)
}

async function refresh(): Promise<void> {
  await loadList()
  if (!state.editing) await loadPage()
  render()
}

async function save(title: string, body: string): Promise<void> {
  if (!state.selected) return
  const res = await call('set', { slug: state.selected, title, body, scope: state.scope })
  if (!res.ok) {
    state.error = errorText(res)
    render()
    return
  }
  state.editing = false
  await refresh()
}

async function create(raw: string): Promise<void> {
  const slug = raw.trim().toLowerCase().replace(/\s+/g, '-')
  if (!slug) return
  const res = await call('set', { slug, title: slug, body: '', scope: state.scope })
  if (!res.ok) {
    state.error = errorText(res)
    render()
    return
  }
  state.selected = slug
  await refresh()
}

function sidebar(): HTMLElement {
  const scopeButton = (scope: Scope, label: string) =>
    h(
      'button',
      {
        'aria-pressed': String(state.scope === scope),
        onclick: () => {
          state.scope = scope
          state.selected = null
          state.editing = false
          void refresh()
        },
      },
      label,
    )
  const slugInput = h('input', {
    class: 'mono',
    placeholder: t.newSlugPlaceholder,
    'aria-label': t.newSlug,
  }) as HTMLInputElement
  slugInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void create(slugInput.value)
  })
  return h(
    'nav',
    { class: 'pages' },
    h(
      'div',
      { class: 'scope', role: 'group', 'aria-label': t.scope },
      scopeButton('project', t.project),
      scopeButton('global', t.global),
    ),
    h(
      'div',
      { class: 'page-list' },
      ...(state.pages.length === 0
        ? [h('div', { class: 'muted empty' }, t.noPages)]
        : state.pages.map((p) =>
            h(
              'button',
              {
                class: `page-link${state.selected === p.slug ? ' selected' : ''}`,
                onclick: () => {
                  state.selected = p.slug
                  state.editing = false
                  void refresh()
                },
              },
              p.title,
            ),
          )),
    ),
    h(
      'div',
      { class: 'new-page' },
      slugInput,
      h('button', { 'aria-label': t.create, onclick: () => void create(slugInput.value) }, '+'),
    ),
  )
}

function content(): HTMLElement {
  const page = state.page
  if (!state.selected || !page) return h('div', { class: 'center muted' }, t.selectOrCreate)
  if (state.editing) {
    const title = h('input', { 'aria-label': t.pageTitle, value: page.title }) as HTMLInputElement
    const body = h('textarea', { class: 'mono', 'aria-label': t.pageBody }) as HTMLTextAreaElement
    body.value = page.body
    return h(
      'div',
      { class: 'editor' },
      title,
      body,
      h(
        'div',
        { class: 'actions' },
        h(
          'button',
          {
            onclick: () => {
              state.editing = false
              render()
            },
          },
          t.cancel,
        ),
        h(
          'button',
          { class: 'primary', onclick: () => void save(title.value, body.value) },
          t.save,
        ),
      ),
    )
  }
  return h(
    'div',
    { class: 'viewer' },
    h(
      'header',
      {},
      h('strong', {}, page.title),
      h(
        'button',
        {
          onclick: () => {
            state.editing = true
            render()
          },
        },
        t.edit,
      ),
    ),
    renderBody(page.body),
  )
}

function render(): void {
  root.replaceChildren(
    h(
      'main',
      { class: 'wiki' },
      sidebar(),
      h(
        'section',
        { class: 'content' },
        state.error ? h('div', { class: 'error banner', role: 'alert' }, state.error) : null,
        content(),
      ),
    ),
  )
}

onChange(() => {
  if (!state.editing) void refresh()
})
void refresh()
