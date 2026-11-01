import { writeFile } from 'node:fs/promises'
import { type BrowserWindow, clipboard, dialog, type IpcMainInvokeEvent, ipcMain } from 'electron'
import {
  INCIDENT_WORDS_MAX,
  type IncidentBlock,
  type IncidentSummary,
} from '../../shared/agents/incident'
import { fromAppWindow } from '../platform/appWindowSender'
import { type IncidentFacts, incidentBlock, incidentText } from './incidentReport'
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

function countsOf(block: IncidentBlock): Record<string, number> {
  const calls = block.events.filter((e) => e.k === 'call' && e.phase === 'start').length
  const failed = block.events.filter((e) => e.k === 'call' && e.code !== undefined).length
  return { calls, failed, events: block.events.length }
}

export function registerIncidentIpc(deps: IncidentIpcDeps): void {
  let last = ''
  const trusted = (e: IpcMainInvokeEvent): boolean => fromAppWindow(deps.appWindows, e)

  ipcMain.handle('incident:list', async (e) => {
    if (!trusted(e)) return [] as IncidentSummary[]
    const out: IncidentSummary[] = []
    for (const item of deps.incidents.list()) {
      const agent = await deps.agentOf(item.paneId)
      if (!agent) continue
      out.push({
        ref: item.paneId,
        trigger: item.trigger,
        agent,
        ageMs: item.ageMs,
        events: item.events,
      })
    }
    return out
  })

  ipcMain.handle('incident:report', async (e, ref: unknown, raw: unknown) => {
    if (!trusted(e)) return null
    const text = typeof ref === 'string' ? ref : ''
    const external = deps.externalOf(text)
    const said = words(raw)
    const take = external ? deps.incidents.take(external) : undefined
    if (!external || !said || !take) return null
    const agent = (await deps.agentOf(external)) ?? 'other'
    const [happened, expected] = await Promise.all([
      deps.redact(said.happened),
      deps.redact(said.expected),
    ])
    const base: IncidentFacts = {
      app: deps.app(),
      platform: process.platform,
      agent: { kind: agent },
      settings: deps.settings(agent),
      counts: {},
      unseen: UNSEEN,
    }
    const counted = incidentBlock(take, base)
    const block = incidentBlock(take, { ...base, counts: countsOf(counted) })
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
