import { wantsDesktopBanner } from '@shared/app/notificationSettings'
import { decodeCommandLine } from '@shared/terminal/commandLine'
import { flushSync } from 'react-dom'
import { clearTypedLaunchOnNewBlock } from '@/lib/agents/resumeTyped'
import { currentDict, fmt } from '@/lib/app/useDict'
import { isPaneViewed, shouldNotifyCommandEnd } from '@/lib/attention/workspaceActivity'
import { readCommandText } from '@/lib/terminal/blockText'
import { isLocalHost, parseOsc7 } from '@/lib/terminal/osc7'
import type { OstiaTerminal, TerminalMarker } from '@/lib/terminal/ostiaTerminal'
import { inputEditorFor } from '@/lib/terminal/terminalHandles'
import { useAttentionStore } from '@/stores/agents/attentionStore'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { type LineAnchor, useBlocksStore } from '@/stores/terminal/blocksStore'
import { useRemoteCwdStore } from '@/stores/terminal/remoteCwdStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import type { TerminalSession } from './terminalSession'

interface ReportedCommand {
  command: string
  typed: boolean
}

function readCommandMark(payload: string, markNonce: string | null): ReportedCommand {
  const [encoded = '', nonce, ...rest] = payload.split(';')
  return {
    command: decodeCommandLine(encoded),
    typed: markNonce !== null && nonce === markNonce && rest.length === 0,
  }
}

interface ShellIntegration {
  anchor: () => LineAnchor
  disposeMarkers: () => void
  dispose: () => void
}

export function createShellIntegration({
  term,
  paneId,
  workspaceIdRef,
  session,
  suppressPrompt,
}: {
  term: OstiaTerminal
  paneId: string
  workspaceIdRef: { current: string }
  session: TerminalSession
  suppressPrompt: (prompt: LineAnchor) => void
}): ShellIntegration {
  const markers = new Set<TerminalMarker>()
  const anchor = (): LineAnchor => {
    const marker = term.registerMarker(0)
    if (!marker) return { line: term.buffer.active.baseY + term.buffer.active.cursorY }
    markers.add(marker)
    marker.onDispose(() => markers.delete(marker))
    return marker
  }
  const disposeMarkers = (): void => {
    for (const marker of [...markers]) marker.dispose()
  }
  let inputAnchor: LineAnchor | null = null
  let inputCol = 0
  let watchingShellLine = false
  let runningCommand = ''
  const onCommandEnd = (exitCode: number, whole: ReportedCommand | null): void => {
    const blocks = useBlocksStore.getState()
    const runningId = blocks.running[paneId]
    const block = runningId ? blocks.byPane[paneId]?.find((b) => b.id === runningId) : undefined
    blocks.commandEnd(
      paneId,
      anchor(),
      exitCode,
      term.buffer.active.cursorX,
      whole?.command,
      whole?.typed ? whole.command : undefined,
    )
    if (!block || session.replaying) return
    const long = shouldNotifyCommandEnd(
      Date.now() - block.startedAt,
      document.hasFocus(),
      useSettingsStore.getState().notifications.longCommandSeconds,
    )
    if (isPaneViewed(paneId) || (exitCode === 0 && !long)) {
      useAttentionStore.getState().dispatch(paneId, { type: 'waitEnded', at: Date.now() })
      return
    }
    const d = currentDict()
    const title =
      exitCode === 0
        ? d.attention.commandFinished
        : fmt(d.attention.commandFailed, { code: exitCode })
    const body = runningCommand || block.cwd || undefined
    useAttentionStore.getState().dispatch(paneId, {
      type: 'commandEnd',
      exitCode,
      long,
      message: body ? `${title}: ${body}` : title,
      at: Date.now(),
    })
    if (long) {
      window.ostia.notifications.post({
        paneId,
        kind: exitCode === 0 ? 'done' : 'error',
        title,
        body,
        desktop: wantsDesktopBanner(
          useSettingsStore.getState().notifications,
          'commandFinished',
          false,
        ),
      })
    }
  }

  const oscCwd = term.parser.registerOscHandler(7, (data) => {
    const report = parseOsc7(data)
    if (!report) return true
    session.remote = !isLocalHost(report.host)
    useRemoteCwdStore
      .getState()
      .report(paneId, session.remote ? { host: report.host, cwd: report.path } : null)
    if (!session.remote) {
      session.cwd = report.path
      useLayoutStore.getState().setCwd(workspaceIdRef.current, paneId, report.path)
    }
    return true
  })
  const shellLine = term.onRender(() => {
    if (!watchingShellLine || session.replaying || !inputAnchor) return
    const buf = term.buffer.active
    if (buf.baseY + buf.cursorY === inputAnchor.line && buf.cursorX === inputCol) return
    watchingShellLine = false
    const prompt = useBlocksStore.getState().drafts[paneId]?.promptLine
    if (!prompt) return
    const draft = inputEditorFor(paneId)?.take() ?? ''
    flushSync(() => suppressPrompt(prompt))
    if (!draft) return
    term.focus()
    term.paste(draft)
  })
  let reportedCommand: ReportedCommand | null = null
  const oscCommandLine = term.parser.registerOscHandler(633, (data) => {
    if (data.startsWith('E;')) reportedCommand = readCommandMark(data.slice(2), session.markNonce)
    return true
  })
  const oscBlocks = term.parser.registerOscHandler(133, (data) => {
    const [kind, arg] = data.split(';')
    const blocks = useBlocksStore.getState()
    if (kind === 'A') {
      session.promptMarker?.dispose()
      session.promptMarker = term.registerMarker(0)
      inputAnchor = null
      watchingShellLine = false
      reportedCommand = null
      blocks.promptStart(paneId, anchor(), session.remote ? null : session.cwd, session.remote)
    } else if (kind === 'B') {
      inputAnchor = anchor()
      inputCol = term.buffer.active.cursorX
      watchingShellLine = true
      blocks.promptEnd(paneId, inputAnchor)
    } else if (kind === 'C') {
      watchingShellLine = false
      const start = anchor()
      const typed = reportedCommand?.typed ? reportedCommand.command : undefined
      runningCommand =
        reportedCommand?.command ??
        (inputAnchor
          ? readCommandText(
              term.buffer.active,
              { line: inputAnchor.line, col: inputCol },
              { line: start.line, col: term.buffer.active.cursorX },
            )
          : '')
      reportedCommand = null
      session.blockSeq += 1
      blocks.commandStart(paneId, start, runningCommand, typed, session.blockSeq)
      clearTypedLaunchOnNewBlock(
        workspaceIdRef.current,
        paneId,
        session.replaying ? runningCommand : typed,
        session.replaying,
      )
      if (!session.replaying) {
        useAttentionStore.getState().dispatch(paneId, { type: 'commandStart', at: Date.now() })
      }
    } else if (kind === 'D') {
      const whole = reportedCommand
      reportedCommand = null
      onCommandEnd(Number(arg ?? 0), whole)
    }
    return true
  })

  return {
    anchor,
    disposeMarkers,
    dispose: () => {
      oscCwd.dispose()
      useRemoteCwdStore.getState().report(paneId, null)
      oscBlocks.dispose()
      shellLine.dispose()
      oscCommandLine.dispose()
      session.promptMarker?.dispose()
      disposeMarkers()
    },
  }
}
