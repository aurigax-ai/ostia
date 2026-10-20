import { h, icon } from '@aurigax-ai/ostia-extension-sdk/panel'
import lockSimple from '@phosphor-icons/core/regular/lock-simple.svg'
import xIcon from '@phosphor-icons/core/regular/x.svg'
import { groupEntries } from './board'
import { refresh } from './panelData'
import { emptyState, failureState, iconButton, markdown, p, relativeTime } from './panelDom'
import { hooks, root, state } from './panelState'
import type { VaultEntrySummary } from './trellis'

function openEntry(slug: string): void {
  if (state.openSlug !== slug) {
    state.entryData = null
    state.entryFailure = null
  }
  state.openSlug = slug
  hooks.render()
  void refresh()
}

function entryRow(entry: VaultEntrySummary): HTMLElement {
  return h(
    'li',
    {},
    h(
      'button',
      {
        class: 'entry',
        'data-key': `entry-${entry.slug}`,
        'data-slug': entry.slug,
        'aria-current': entry.slug === state.openSlug ? 'true' : 'false',
        onclick: () => openEntry(entry.slug),
      },
      h(
        'span',
        { class: 'entry-title' },
        entry.private ? icon(lockSimple) : null,
        entry.title,
        entry.template ? h('span', { class: 'chip' }, entry.template) : null,
      ),
      entry.summary ? h('span', { class: 'entry-summary muted' }, entry.summary) : null,
    ),
  )
}

function entryView(slug: string): HTMLElement {
  const head = h(
    'header',
    { class: 'detail-head' },
    h('span', { class: 'card-ref' }, slug),
    h('span', { class: 'ostia-spacer' }),
    iconButton(
      p('vault.close'),
      xIcon,
      () => {
        state.openSlug = null
        state.entryData = null
        hooks.render()
        root.querySelector<HTMLElement>(`[data-key="entry-${slug}"]`)?.focus()
      },
      { 'data-key': 'entry-close' },
    ),
  )
  const attrs = { class: 'detail entry-detail', 'aria-label': slug, 'data-scroll': 'entry' }
  if (state.entryFailure) return h('article', attrs, head, failureState(state.entryFailure))
  if (!state.entryData || state.entryData.slug !== slug) {
    return h('article', attrs, head, emptyState(p('loading')))
  }
  const entry = state.entryData
  return h(
    'article',
    attrs,
    head,
    h('h1', { class: 'detail-title' }, entry.title),
    h(
      'div',
      { class: 'meta' },
      entry.template ? h('span', { class: 'chip' }, entry.template) : null,
      entry.private ? h('span', { class: 'chip' }, icon(lockSimple), p('vault.private')) : null,
      ...entry.tags.map((tag) => h('span', { class: 'chip' }, tag)),
      h('span', { class: 'ostia-spacer' }),
      h('span', { class: 'muted' }, p('card.updated', { time: relativeTime(entry.updatedAt) })),
    ),
    entry.summary ? h('p', { class: 'summary' }, entry.summary) : null,
    markdown(entry.body),
    entry.sources.length > 0
      ? h(
          'section',
          { class: 'relations', 'aria-label': p('vault.sources') },
          h('h3', {}, p('vault.sources')),
          h('ul', {}, ...entry.sources.map((s) => h('li', { class: 'source' }, s))),
        )
      : null,
  )
}

export function vaultView(): HTMLElement {
  if (state.vaultFailure) return failureState(state.vaultFailure)
  if (!state.entries) return emptyState(p('loading'))
  if (state.entries.length === 0) return emptyState(p('vault.empty'))
  const filter = h('input', {
    type: 'search',
    class: 'filter',
    'data-key': 'entry-filter',
    'aria-label': p('filterEntries'),
    placeholder: p('filterEntries'),
    oninput: (e) => {
      state.entryQuery = (e.target as HTMLInputElement).value
      hooks.render()
    },
  }) as HTMLInputElement
  filter.value = state.entryQuery
  const groups = groupEntries(state.entries, state.entryQuery)
  return h(
    'div',
    { class: `vault-layout${state.openSlug ? ' has-detail' : ''}` },
    h(
      'div',
      { class: 'vault-list', 'data-scroll': 'vault-list' },
      h('div', { class: 'filter-row' }, filter),
      groups.length === 0 ? h('p', { class: 'muted note' }, p('vault.noMatch')) : null,
      ...groups.map((group) =>
        h(
          'section',
          { 'aria-label': group.dir || p('vault.top') },
          h('h2', { class: 'group-name' }, group.dir || p('vault.top')),
          h('ul', { class: 'entries' }, ...group.entries.map(entryRow)),
        ),
      ),
    ),
    state.openSlug
      ? entryView(state.openSlug)
      : h('div', { class: 'vault-hint' }, emptyState(p('vault.pick'))),
  )
}
