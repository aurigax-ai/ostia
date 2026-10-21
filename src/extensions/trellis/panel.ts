import { call, errorText, h, icon, onChange } from '@aurigax-ai/ostia-extension-sdk/panel'
import arrowClockwise from '@phosphor-icons/core/regular/arrow-clockwise.svg'
import plus from '@phosphor-icons/core/regular/plus.svg'
import { boardView, openNewCard } from './panelBoard'
import { closeCard } from './panelCard'
import { refresh } from './panelData'
import { emptyState, failureState, iconButton, p, select, show } from './panelDom'
import { type View, hooks, state } from './panelState'
import { vaultView } from './panelVault'

function setView(next: View): void {
  state.view = next
  state.banner = null
  void refresh()
}

function setProject(next: string): void {
  state.project = next
  state.boardSlug =
    state.ctx?.workspace?.project === next ? (state.ctx.workspace.board ?? null) : null
  state.boardData = null
  state.entries = null
  state.openRef = null
  state.cardData = null
  state.openSlug = null
  state.entryData = null
  state.newCard = null
  state.banner = null
  void refresh()
}

function toolbar(): HTMLElement {
  const views: View[] = ['board', 'vault']
  const projects = state.ctx?.projects ?? []
  const boards = state.boardData?.boards ?? []
  return h(
    'nav',
    { class: 'ostia-toolbar' },
    h(
      'div',
      { class: 'ostia-tabs', role: 'tablist' },
      ...views.map((v) =>
        h(
          'button',
          {
            class: 'ostia-tab',
            role: 'tab',
            'data-key': `tab-${v}`,
            'aria-selected': v === state.view ? 'true' : 'false',
            onclick: () => setView(v),
          },
          p(`tab.${v}`),
        ),
      ),
    ),
    projects.length > 0 && state.project
      ? select(
          'project',
          p('project'),
          projects.map((x) => ({ value: x.key, text: x.key })),
          state.project,
          setProject,
        )
      : projects.length > 0
        ? select(
            'project',
            p('project'),
            [
              { value: '', text: p('project') },
              ...projects.map((x) => ({ value: x.key, text: x.key })),
            ],
            '',
            (value) => value && setProject(value),
          )
        : null,
    state.view === 'board' && boards.length > 1 && state.boardData
      ? select(
          'board',
          p('board'),
          boards.map((b) => ({ value: b.slug, text: b.name })),
          state.boardData.board.slug,
          (slug) => {
            state.boardSlug = slug
            void refresh()
          },
        )
      : null,
    h('span', { class: 'ostia-spacer' }),
    state.view === 'board' && state.boardData
      ? h(
          'button',
          { class: 'with-icon', 'data-key': 'new-card', onclick: openNewCard },
          icon(plus),
          p('newCard'),
        )
      : null,
    iconButton(p('refresh'), arrowClockwise, () => void refresh(), { 'data-key': 'refresh' }),
  )
}

function bannerView(): HTMLElement | null {
  if (state.banner) return h('div', { class: 'banner error', role: 'alert' }, state.banner)
  return state.notice ? h('div', { class: 'banner', role: 'status' }, state.notice) : null
}

async function initProject(): Promise<void> {
  const res = await call('init')
  state.banner = res.ok || res.error === 'cancelled' ? null : errorText(res)
  state.ctx = null
  await refresh()
}

function body(): HTMLElement {
  if (state.failed) return failureState(state.failed)
  if (!state.ctx) return emptyState(p('loading'))
  if (!state.project) {
    const init = state.ctx.canInit
      ? h('button', { 'data-key': 'init', onclick: () => void initProject() }, p('empty.init'))
      : undefined
    return state.ctx.projects.length === 0 && !state.ctx.canInit
      ? emptyState(p('empty.noProjects'))
      : emptyState(p('empty.noProject'), p('empty.noProjectHint'), 'muted', init)
  }
  return state.view === 'vault' ? vaultView() : boardView()
}

function render(): void {
  show(h('main', { class: 'ostia-page' }, toolbar(), bannerView(), body()))
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented) return
  const target = e.target as HTMLElement | null
  if (target?.closest('.new-card')) return
  if (state.workMenu) {
    state.workMenu = null
    render()
    return
  }
  if (state.view === 'board' && state.openRef) closeCard()
})

document.addEventListener('pointerdown', (e) => {
  if (!state.workMenu || (e.target as HTMLElement | null)?.closest('.work')) return
  state.workMenu = null
  render()
})

hooks.render = render
render()
onChange(() => void refresh())
void refresh()
