import {
  call,
  context,
  errorText,
  h,
  onChange,
  panelTranslator,
} from '@aurigax-ai/ostia-extension-sdk/panel'
import en from './locales/en.json'
import zhHant from './locales/zh-Hant.json'
import type { Definition, GraphRow, ListModel, RunModel } from './panelModel'

const t = panelTranslator({ en: en.messages, 'zh-Hant': zhHant.messages })
const root = document.getElementById('root') as HTMLElement

type View =
  | { kind: 'list' }
  | { kind: 'definition'; name: string }
  | { kind: 'runs'; name: string }
  | { kind: 'run'; runId: string }

const startRun = new URLSearchParams(location.search).get('run')
let view: View = startRun ? { kind: 'run', runId: startRun } : { kind: 'list' }
let problem = ''

function go(next: View): void {
  view = next
  problem = ''
  void render()
}

function button(label: string, onClick: () => void, primary = false): HTMLElement {
  return h('button', { type: 'button', class: primary ? 'primary' : '', onClick }, label)
}

async function act(command: string, args: Record<string, unknown>): Promise<boolean> {
  const res = await call(command, { workspaceId: context.workspaceId, ...args })
  problem = res.ok ? '' : t('error', { error: errorText(res) })
  await render()
  return res.ok
}

function pretty(value: unknown): HTMLElement {
  return h('div', { class: 'mono' }, JSON.stringify(value, null, 2))
}

function graphRow(row: GraphRow): HTMLElement {
  const actions = h(
    'div',
    { class: 'actions' },
    row.state !== 'invalid'
      ? button(t('action.view'), () => go({ kind: 'definition', name: row.name }))
      : null,
    row.state === 'enabled' ? button(t('action.runNow'), () => void runNow(row.name), true) : null,
    row.state === 'enabled'
      ? button(t('action.disable'), () => void act('disable', { name: row.name }))
      : null,
    button(t('action.runs'), () => go({ kind: 'runs', name: row.name })),
  )
  return h(
    'li',
    { class: 'row', 'data-graph': row.name, 'data-state': row.state },
    h(
      'div',
      { class: 'row-head' },
      h('span', { class: 'name' }, row.name),
      h('span', { class: 'state', 'data-state': row.state }, t(`state.${row.state}`)),
      row.lastRun
        ? h(
            'span',
            { class: 'state', 'data-status': row.lastRun.status },
            t('lastRun', { status: t(`status.${row.lastRun.status}`) }),
          )
        : null,
    ),
    row.description ? h('div', { class: 'muted' }, row.description) : null,
    row.filesRefused
      ? h('div', { class: 'error', 'data-files-refused': '' }, t('row.filesRefused'))
      : null,
    row.skipped
      ? h(
          'div',
          { class: 'muted', 'data-skipped': String(row.skipped) },
          t('row.skipped', { count: row.skipped }),
        )
      : null,
    row.problem
      ? h(
          'div',
          { class: 'error mono', 'data-problem': row.problem.code },
          `${row.problem.code}${row.problem.node ? ` (${row.problem.node})` : ''}: ${row.problem.message}`,
        )
      : null,
    actions,
  )
}

async function runNow(name: string): Promise<void> {
  const res = await call('runNow', { workspaceId: context.workspaceId, name })
  if (res.ok && (res.data as { runId?: string } | undefined)?.runId) {
    go({ kind: 'run', runId: (res.data as { runId: string }).runId })
    return
  }
  problem = res.ok ? '' : t('error', { error: errorText(res) })
  await render()
}

async function listView(): Promise<HTMLElement[]> {
  const res = await call('list', { workspaceId: context.workspaceId })
  if (!res.ok) return [h('p', { class: 'error' }, t('error', { error: errorText(res) }))]
  const model = res.data as ListModel
  if (model.scratch)
    return [h('p', { class: 'muted', 'data-empty': 'scratch' }, t('empty.scratch'))]
  if (model.graphs.length === 0) {
    return [
      h(
        'p',
        { class: 'muted', 'data-empty': 'folder' },
        t('empty.folder', { folder: model.folder }),
      ),
    ]
  }
  return [h('ul', { class: 'rows' }, ...model.graphs.map(graphRow))]
}

function edgeText(edge: Definition['edges'][number]): string {
  const tail =
    edge.kind === 'when'
      ? t('def.when', { condition: edge.condition ?? '' })
      : edge.kind === 'else'
        ? t('def.else')
        : edge.kind === 'join'
          ? t('def.join')
          : ''
  return `${edge.from} -> ${edge.to}${tail ? `  ${tail}` : ''}`
}

async function definitionView(name: string): Promise<HTMLElement[]> {
  const res = await call('definition', { workspaceId: context.workspaceId, name })
  if (!res.ok) return [h('p', { class: 'error' }, t('error', { error: errorText(res) }))]
  const def = res.data as Definition & { state: string }
  const canEnable = def.state !== 'enabled' && def.problems.length === 0
  return [
    h('p', { class: 'note' }, t('def.enableNote')),
    h('p', { class: 'note' }, t('def.scripts')),
    h('div', { class: 'section' }, t('def.triggers')),
    ...def.triggers.map((tr) =>
      h(
        'div',
        { class: 'mono', 'data-trigger': tr.kind },
        `${tr.kind} ${JSON.stringify(tr.detail)}${tr.kind === 'manual' ? ` (${def.agentsMayStart ? t('def.agentsMayStart') : t('def.humanOnly')})` : ''}`,
      ),
    ),
    h('div', { class: 'muted' }, t('def.start', { nodes: def.start.join(', ') })),
    h('div', { class: 'section' }, t('def.nodes')),
    h(
      'ul',
      { class: 'rows' },
      ...def.nodes.map((n) =>
        h(
          'li',
          { class: 'row', 'data-node': n.id },
          h(
            'div',
            { class: 'row-head' },
            h('span', { class: 'name' }, n.id),
            h('span', { class: 'state' }, `${n.kind}: ${t(`effect.${n.effect}`)}`),
            n.once ? h('span', { class: 'state' }, t('def.once')) : null,
          ),
          pretty({
            with: n.fields,
            ...(n.result ? { result: n.result } : {}),
            ...(n.out ? { out: n.out } : {}),
            ...(n.timeout ? { timeout: n.timeout } : {}),
          }),
        ),
      ),
    ),
    h('div', { class: 'section' }, t('def.edges')),
    ...def.edges.map((e) =>
      h('div', { class: 'mono', 'data-edge': `${e.from}>${e.to}` }, edgeText(e)),
    ),
    h('div', { class: 'section' }, t('def.state')),
    pretty(def.state),
    h('div', { class: 'section' }, t('def.limits')),
    Object.keys(def.limits).length > 0
      ? pretty(def.limits)
      : h('div', { class: 'muted' }, t('def.defaults')),
    h('div', { class: 'muted' }, t('def.kinds', { kinds: def.kinds.join(', ') })),
    h(
      'div',
      { class: 'muted' },
      t('def.connectors', { connectors: def.connectors.join(', ') || t('def.none') }),
    ),
    ...def.connectorUses.flatMap((u) => [
      h(
        'div',
        { class: 'mono', 'data-connector': u.node, 'data-effect': u.effect },
        t(u.connection ? 'def.useVia' : 'def.use', {
          node: u.node,
          use: u.use,
          connection: u.connection ?? '',
          effect: t(`use.${u.effect}`),
        }),
      ),
      u.secretShaped
        ? h(
            'div',
            { class: 'error', 'data-secret-warning': u.node },
            t('def.secretInput', { node: u.node }),
          )
        : null,
    ]),
    def.problems.length > 0
      ? h(
          'div',
          { class: 'error' },
          `${t('def.problems')}: ${def.problems.map((p) => p.message).join('; ')}`,
        )
      : null,
    h(
      'div',
      { class: 'actions' },
      canEnable
        ? button(
            t('action.enable'),
            () => void act('enable', { name, fingerprint: def.fingerprint }),
            true,
          )
        : null,
      def.state === 'enabled'
        ? button(t('action.disable'), () => void act('disable', { name }))
        : null,
    ),
  ].filter((el): el is HTMLElement => el !== null)
}

async function runsView(name: string): Promise<HTMLElement[]> {
  const res = await call('runs', { workspaceId: context.workspaceId, name })
  if (!res.ok) return [h('p', { class: 'error' }, t('error', { error: errorText(res) }))]
  const runs = res.data as { runId: string; status: string; steps: number }[]
  if (runs.length === 0) return [h('p', { class: 'muted', 'data-empty': 'runs' }, t('runs.none'))]
  return [
    h(
      'ul',
      { class: 'rows' },
      ...runs.map((r) =>
        h(
          'li',
          { class: 'row', 'data-run': r.runId },
          h(
            'div',
            { class: 'row-head' },
            button(r.runId, () => go({ kind: 'run', runId: r.runId })),
            h('span', { class: 'state', 'data-status': r.status }, t(`status.${r.status}`)),
            h('span', { class: 'muted' }, t('run.steps', { count: r.steps })),
          ),
        ),
      ),
    ),
  ]
}

function control(runId: string, action: string, node?: string): HTMLElement {
  return button(
    t(`action.${action}`),
    () => void act('control', { runId, action, ...(node ? { node } : {}) }),
  )
}

async function runView(runId: string): Promise<HTMLElement[]> {
  const res = await call('run', { workspaceId: context.workspaceId, runId })
  if (!res.ok) return [h('p', { class: 'error' }, t('error', { error: errorText(res) }))]
  const run = res.data as RunModel
  const status = run.summary.status
  const ended = !['running', 'waiting', 'paused', 'interrupted'].includes(status)
  return [
    h(
      'div',
      { class: 'row-head' },
      h('span', { class: 'name' }, run.graph),
      h(
        'span',
        { class: 'state', 'data-status': status, 'data-run-status': status },
        t(`status.${status}`),
      ),
    ),
    h(
      'div',
      { class: 'actions' },
      !ended && status !== 'paused' ? control(runId, 'pause') : null,
      status === 'paused' ? control(runId, 'resume') : null,
      !ended ? control(runId, 'cancel') : null,
      status === 'failed' ? control(runId, 'retry') : null,
    ),
    h(
      'ul',
      { class: 'rows' },
      ...run.nodes.map((n) => {
        const pane = (n as { pane?: string }).pane
        return h(
          'li',
          { class: 'row', 'data-node': n.node, 'data-status': n.status },
          h(
            'div',
            { class: 'row-head' },
            h('span', { class: 'name' }, n.node),
            h('span', { class: 'state', 'data-status': n.status }, t(`status.${n.status}`)),
            h('span', { class: 'muted' }, t('node.attempt', { attempt: n.attempt })),
            pane ? button(t('action.showPane'), () => void call('focus', { paneId: pane })) : null,
          ),
          n.status === 'interrupted'
            ? h(
                'div',
                {},
                h('p', { class: 'note' }, t('node.interrupted')),
                h(
                  'div',
                  { class: 'actions' },
                  control(runId, 'rerun', n.node),
                  n.started?.pane ? control(runId, 'continue', n.node) : null,
                  control(runId, 'skip', n.node),
                ),
              )
            : null,
          n.error ? h('div', { class: 'error mono' }, `${n.error.name}: ${n.error.message}`) : null,
          h('details', {}, h('summary', {}, t('node.input')), pretty(n.input)),
          n.output ? h('details', {}, h('summary', {}, t('node.output')), pretty(n.output)) : null,
          n.wait ? h('details', {}, h('summary', {}, t('node.wait')), pretty(n.wait)) : null,
          n.stateAfter
            ? h('details', {}, h('summary', {}, t('node.state')), pretty(n.stateAfter))
            : null,
        )
      }),
    ),
  ]
}

async function render(): Promise<void> {
  const body =
    view.kind === 'list'
      ? await listView()
      : view.kind === 'definition'
        ? await definitionView(view.name)
        : view.kind === 'runs'
          ? await runsView(view.name)
          : await runView(view.runId)
  const back = view.kind === 'list' ? null : button(t('action.back'), () => go({ kind: 'list' }))
  root.replaceChildren(
    h(
      'div',
      { class: 'page' },
      h(
        'header',
        { class: 'toolbar' },
        back,
        h('h1', { class: 'title' }, t('title')),
        h('div', { class: 'spacer' }),
      ),
      h(
        'main',
        { class: 'body' },
        h('p', { class: 'note muted' }, t('runsWhileOpen')),
        problem ? h('p', { class: 'error', role: 'alert' }, problem) : null,
        ...body,
      ),
    ),
  )
}

onChange(() => void render())
void render()
