import { PALETTE_TOGGLE } from '@shared/keyboard/chordSpec'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { commands } from '@/commands/registry'
import { ChatView } from '@/components/chat/ChatView'
import { Command } from '@/components/ui/command'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { fmt, useDict } from '@/lib/app/useDict'
import { useChatAvailable } from '@/lib/assist/assistFeatures'
import { matchChord, runAppChord } from '@/lib/keyboard/chords'
import { firstPaneOfKind } from '@/lib/layout/paneFields'
import { isComposingEscape, swallowHeldEscape } from '@/lib/palette/paletteEscape'
import { paletteFilter } from '@/lib/palette/paletteFilter'
import { paletteReturnFocus } from '@/lib/palette/paletteFocus'
import { paletteMode } from '@/lib/palette/paletteModes'
import { cn } from '@/lib/utils'
import { isMac } from '@/platform'
import { useUIStore } from '@/stores/app/uiStore'
import { useAssistProvider } from '@/stores/assist/assistStore'
import { chatFor, currentSessionId } from '@/stores/assist/chatStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import { type ArgumentCommand, ArgumentStep } from './ArgumentStep'
import { EMPTY_PLACES, snapshotPlaces } from './PlaceItems'
import { SearchStep } from './SearchStep'

const subscribeCommands = (cb: () => void): (() => void) => commands.subscribe(cb)
const commandsVersion = (): number => commands.version()

function stopUnseenAnswer(): void {
  const workspaceId = useWorkspacesStore.getState().activeWorkspaceId
  const layout = workspaceId ? useLayoutStore.getState().byWorkspace[workspaceId] : undefined
  if (layout && firstPaneOfKind(layout.root, 'chat')) return
  const sessionId = currentSessionId(workspaceId)
  if (sessionId) void chatFor(sessionId).stop()
}

export function CommandPalette(): JSX.Element {
  const d = useDict()
  const open = useUIStore((s) => s.paletteOpen)
  const close = useUIStore((s) => s.closePalette)
  const openMode = useUIStore((s) => s.paletteMode)
  const seed = useUIStore((s) => s.paletteSeed)
  const provider = useAssistProvider('chat')
  const chat = useChatAvailable() ? provider : null
  const [search, setSearch] = useState('')
  const [asking, setAsking] = useState<ArgumentCommand | null>(null)
  const [askSeed, setAskSeed] = useState('')
  const [selected, setSelected] = useState('')
  const mode = paletteMode(search)
  const places = useMemo(() => (open ? snapshotPlaces() : EMPTY_PLACES), [open])
  const askMode = openMode === 'ask' && chat !== null
  const everywhere = openMode === 'everywhere' && mode === 'all' && search.trim() !== ''
  const placeholder =
    openMode === 'everywhere' ? d.palette.everywherePlaceholder : d.palette.placeholder
  const activeWorkspaceId = useWorkspacesStore((s) => s.activeWorkspaceId)
  const activeWorkDir = useWorkspacesStore(
    (s) => s.workspaces.find((w) => w.id === s.activeWorkspaceId)?.workDir ?? null,
  )

  useSyncExternalStore(subscribeCommands, commandsVersion)

  const wasAsking = useRef(false)
  useEffect(() => {
    if (open) {
      wasAsking.current = askMode
      return
    }
    setSearch('')
    setAsking(null)
    setAskSeed('')
    if (wasAsking.current) stopUnseenAnswer()
    wasAsking.current = false
  }, [open, askMode])

  useEffect(() => {
    if (open && seed) setSearch(seed)
  }, [open, seed])

  const enterAsk = (seed: string): void => {
    setAskSeed(seed)
    setSearch('')
    useUIStore.getState().setPaletteMode('ask')
  }

  const leaveAsk = (): void => {
    setAskSeed('')
    useUIStore.getState().setPaletteMode('search')
  }

  const finish = close

  const ask = (command: ArgumentCommand): void => {
    setAsking(command)
    setSearch('')
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o, details) => {
        if (o) return
        if (details.reason === 'escape-key') swallowHeldEscape()
        finish()
      }}
    >
      <DialogHeader className="sr-only">
        <DialogTitle>
          {askMode && chat
            ? fmt(d.ask.tabHint, { name: chat.name })
            : openMode === 'everywhere'
              ? d.palette.everywhereTitle
              : d.palette.title}
        </DialogTitle>
        <DialogDescription>{askMode ? d.ask.placeholder : placeholder}</DialogDescription>
      </DialogHeader>
      <DialogContent
        className={cn(
          'top-[12vh] origin-top translate-y-0 overflow-hidden rounded-xl! p-0',
          askMode ? 'sm:max-w-3xl' : 'sm:max-w-[47rem]',
        )}
        showCloseButton={false}
        finalFocus={paletteReturnFocus}
      >
        <Command
          onKeyDownCapture={(e) => {
            if (!askMode && isComposingEscape(e.nativeEvent)) {
              e.preventDefault()
              e.stopPropagation()
              swallowHeldEscape()
              finish()
              return
            }
            if (matchChord(e.nativeEvent, isMac) !== PALETTE_TOGGLE) return
            e.stopPropagation()
            runAppChord(e.nativeEvent, isMac)
          }}
          filter={paletteFilter}
          shouldFilter={mode !== 'files'}
          value={mode === 'files' ? selected : undefined}
          onValueChange={setSelected}
        >
          {askMode && chat ? (
            <ChatView
              workspaceId={activeWorkspaceId}
              variant="palette"
              seed={askSeed}
              onBack={leaveAsk}
              onInserted={finish}
            />
          ) : asking ? (
            <ArgumentStep
              command={asking}
              value={search}
              onValueChange={setSearch}
              onDone={finish}
            />
          ) : (
            <SearchStep
              search={search}
              onSearchChange={setSearch}
              mode={mode}
              placeholder={placeholder}
              chat={chat}
              places={places}
              everywhere={everywhere}
              workspaceId={activeWorkspaceId}
              workDir={activeWorkDir}
              onSelect={setSelected}
              onDone={finish}
              onAsk={ask}
              onEnterAsk={enterAsk}
            />
          )}
        </Command>
      </DialogContent>
    </Dialog>
  )
}
