import { writeFile } from 'node:fs/promises'
import { type BrowserWindow, clipboard, dialog, type IpcMainInvokeEvent, ipcMain } from 'electron'
import {
  INCIDENT_PERIOD_MS,
  INCIDENT_WORDS_MAX,
  type IncidentPeriod,
  type IncidentSummary,
} from '../../shared/agents/incident'
import { fromAppWindow } from '../platform/appWindowSender'
import { incidentBlock, incidentText } from './incidentReport'
import type { IncidentTimeline } from './incidentTimeline'

const ISSUE_URL = 'https://github.com/aurigax-ai/ostia/issues/new'
const UNSEEN = ['agent-internals', 'terminal-text', 'model-output', 'prompt-text']

export interface IncidentIpcDeps {
  incidents: IncidentTimeline
  redact: (text: string) => Promise<{ text: string; count: number }>
  appWindows: () => Iterable<BrowserWindow>
  externalOf: (ref: string) => string | undefined
  agentOf: (externalId: string) => Promise<string | undefined>
  settings: (agent: string) => Record<string, boolean>
  app: () => string
  openExternal: (url: string) => boolean
}

function words(raw: unknown): { happened: string; expected: string } | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { happened, expected } = raw as Record<string, unknown>
  if (typeof happened !== 'string' || typeof expected !== 'string') return null
  if (happened.length > INCIDENT_WORDS_MAX || expected.length > INCIDENT_WORDS_MAX) return null
  return { happened, expected }
}

export function registerIncidentIpc(deps: IncidentIpcDeps): void {
  let last = ''
  const trusted = (e: IpcMainInvokeEvent): boolean => fromAppWindow(deps.appWindows, e)

  ipcMain.handle('incident:list', async (e, period: unknown) => {
    if (!trusted(e) || typeof period !== 'string' || !(period in INCIDENT_PERIOD_MS)) {
      return [] as IncidentSummary[]
    }
    const grouped = new Map<string, IncidentSummary>()
    for (const item of deps.incidents.list(INCIDENT_PERIOD_MS[period as IncidentPeriod])) {
      const key = `${item.trigger}|${item.agent}`
      const have = grouped.get(key)
      if (have) have.count += 1
      else grouped.set(key, { ...item, count: 1 })
    }
    return [...grouped.values()]
  })

  ipcMain.handle('incident:report', async (e, ref: unknown, raw: unknown) => {
    if (!trusted(e)) return null
    const text = typeof ref === 'string' ? ref : ''
    const said = words(raw)
    const external = deps.externalOf(text) ?? text
    const take = deps.incidents.take(external)
    if (!said || !take) return null
    const agent =
      take.agent === 'other' ? ((await deps.agentOf(take.paneId)) ?? 'other') : take.agent
    const [happened, expected] = await Promise.all([
      deps.redact(said.happened),
      deps.redact(said.expected),
    ])
    const totals = deps.incidents.totals()
    const block = incidentBlock(take, {
      app: deps.app(),
      platform: process.platform,
      agent: { kind: agent },
      settings: deps.settings(agent),
      counts: totals.counts,
      sinceMin: totals.sinceMin,
      unseen: UNSEEN,
    })
    last = incidentText(block, { happened: happened.text, expected: expected.text })
    return { text: last, redacted: happened.count + expected.count }
  })

  ipcMain.handle('incident:save', async (e) => {
    if (!trusted(e)) return false
    if (last === '') return false
    const picked = await dialog.showSaveDialog({ defaultPath: 'ostia-incident.md' })
    if (picked.canceled || !picked.filePath) return false
    await writeFile(picked.filePath, last, 'utf8')
    return true
  })

  ipcMain.handle('incident:open-issue', (e) => {
    if (!trusted(e)) return false
    if (last === '') return false
    clipboard.writeText(last)
    const title = encodeURIComponent('Agent stalled')
    const body = encodeURIComponent('Paste the report here (it is on your clipboard).')
    return deps.openExternal(`${ISSUE_URL}?title=${title}&body=${body}`)
  })

  ipcMain.handle('incident:clear', (e) => {
    if (!trusted(e)) return false
    deps.incidents.clear()
    last = ''
    return true
  })
}
