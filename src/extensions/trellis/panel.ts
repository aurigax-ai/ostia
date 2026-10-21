import {
  call,
  errorText,
  h,
  onChange,
  onPanelToolbar,
  setPanelToolbar,
} from '@aurigax-ai/ostia-extension-sdk/panel'
import { boardView, openNewCard } from './panelBoard'
import { closeCard } from './panelCard'
import { refresh } from './panelData'
import { emptyState, failureState, p, select, show } from './panelDom'
import { hooks, state, type View } from './panelState'
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

function scopeRow(): HTMLElement | null {
  const projects = state.ctx?.projects ?? []
  const boards = state.boardData?.boards ?? []
  const projectSelect =
    projects.length === 0
      ? null
      : state.project
        ? select(
            'project',
            p('project'),
            projects.map((x) => ({ value: x.key, text: x.key })),
            state.project,
            setProject,
          )
        : select(
            'project',
            p('project'),
            [
              { value: '', text: p('project') },
              ...projects.map((x) => ({ value: x.key, text: x.key })),
            ],
            '',
            (value) => value && setProject(value),
          )
  const boardSelect =
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
      : null
  return projectSelect || boardSelect
    ? h('div', { class: 'scope-row' }, projectSelect, boardSelect)
    : null
}

function syncToolbar(): void {
  setPanelToolbar({
    tab: state.view,
    hidden: state.view === 'board' && state.boardData ? [] : ['new-card'],
  })
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
  syncToolbar()
  show(h('main', { class: 'ostia-page' }, scopeRow(), bannerView(), body()))
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

onPanelToolbar((event) => {
  if (event.kind === 'tab') setView(event.id as View)
  else if (event.kind === 'action' && event.id === 'refresh') void refresh()
  else if (event.kind === 'action' && event.id === 'new-card') openNewCard()
})

hooks.render = render
render()
onChange(() => void refresh())
void refresh()
