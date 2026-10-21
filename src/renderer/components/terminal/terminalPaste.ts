import type { HumanInputSource } from '@shared/terminal/ptyApi'
import {
  CLIPBOARD_READ_MS,
  keyPastePlan,
  NO_CLIPBOARD_CONTENTS,
  PROGRAM_PASTE_KEY,
  pasteEventReadsClipboard,
  settleWithin,
} from '@/lib/keyboard/clipboardKeys'
import { pathsAsInput } from '@/lib/keyboard/dropPaths'
import { planDraftPaste, planHumanPaste } from '@/lib/keyboard/pasteGate'
import { asHumanPaste } from '@/lib/terminal/humanInput'
import type { OstiaTerminal } from '@/lib/terminal/ostiaTerminal'
import { inputEditorFor } from '@/lib/terminal/terminalHandles'
import { isMac } from '@/platform'
import { useSettingsStore } from '@/stores/app/settingsStore'
import type { TerminalSession } from './terminalSession'

interface TerminalPaste {
  pasteConfirmed: (text: string, reference?: boolean) => void
  pasteFromClipboard: (eventText?: string | null) => void
  holdInput: (data: string, source: HumanInputSource | undefined) => boolean
  dispose: () => void
}

export function createTerminalPaste({
  host,
  term,
  paneId,
  session,
  setPendingPaste,
}: {
  host: HTMLElement
  term: OstiaTerminal
  paneId: string
  session: TerminalSession
  setPendingPaste: (text: string | null) => void
}): TerminalPaste {
  const pasteConfirmed = (text: string, reference = false): void => {
    const editor = inputEditorFor(paneId)
    if (editor) editor.type(text)
    else if (reference) term.paste(text)
    else asHumanPaste(() => term.paste(text))
  }
  const planPaste = (text: string) =>
    planHumanPaste(text, useSettingsStore.getState().terminal.warnOnRiskyPaste)
  const requestPaste = (text: string): void => {
    if (session.disposed) return
    const editor = inputEditorFor(paneId)
    if (editor) {
      const draft = planDraftPaste(text)
      if (draft) editor.type(draft)
      return
    }
    const plan = planPaste(text)
    if (plan.confirm) setPendingPaste(plan.text)
    else if (plan.text) pasteConfirmed(plan.text)
  }
  let heldInput: { data: string; source: HumanInputSource | undefined }[] | null = null
  let pasting: Promise<void> = Promise.resolve()
  const pastePlanned = async (eventText: string | null): Promise<void> => {
    const text =
      eventText ?? (await settleWithin(navigator.clipboard.readText(), CLIPBOARD_READ_MS, ''))
    if (session.disposed) return
    const editorShown = Boolean(inputEditorFor(paneId))
    const contents = editorShown
      ? NO_CLIPBOARD_CONTENTS
      : await settleWithin(
          window.ostia.clipboard.contents(),
          CLIPBOARD_READ_MS,
          NO_CLIPBOARD_CONTENTS,
        )
    if (session.disposed) return
    const plan = keyPastePlan(text, editorShown, contents)
    const held = heldInput
    heldInput = null
    try {
      if (plan === 'text') requestPaste(text)
      else if (plan === 'files') pasteConfirmed(pathsAsInput(contents.files), true)
      else if (plan === 'program') term.input(PROGRAM_PASTE_KEY, true)
    } finally {
      heldInput = held
    }
  }
  const pasteFromClipboard = (eventText: string | null = null): void => {
    heldInput ??= []
    const run = pasting.then(() => pastePlanned(eventText)).catch(() => {})
    pasting = run
    void run.then(() => {
      if (pasting !== run) return
      const held = heldInput ?? []
      heldInput = null
      if (session.disposed) return
      for (const { data, source } of held) window.ostia.pty.write(paneId, data, source)
    })
  }
  const interceptPaste = (e: ClipboardEvent): void => {
    const text = e.clipboardData?.getData('text/plain') ?? ''
    const types = [...(e.clipboardData?.types ?? [])]
    if (pasteEventReadsClipboard(types, text, Boolean(inputEditorFor(paneId)), isMac)) {
      e.preventDefault()
      e.stopImmediatePropagation()
      pasteFromClipboard(text)
      return
    }
    if (!inputEditorFor(paneId)) {
      const plan = planPaste(text)
      if (!plan.confirm && plan.text === text) return
    }
    e.preventDefault()
    e.stopImmediatePropagation()
    requestPaste(text)
  }
  host.addEventListener('paste', interceptPaste, true)
  const holdInput = (data: string, source: HumanInputSource | undefined): boolean => {
    if (!heldInput) return false
    heldInput.push({ data, source })
    return true
  }
  return {
    pasteConfirmed,
    pasteFromClipboard,
    holdInput,
    dispose: () => host.removeEventListener('paste', interceptPaste, true),
  }
}
