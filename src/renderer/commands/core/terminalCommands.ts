import { type CoreCommandId, registerCore } from '@/commands/coreCommand'
import { openSnippetPicker } from '@/lib/palette/snippets'
import {
  type BlockPart,
  copyBlock,
  insertCommand,
  rerunBlock,
  stepBlock,
} from '@/lib/terminal/blockActions'
import { clearKeepingScrollback } from '@/lib/terminal/clearTerminal'
import { showHistoryAboveLive } from '@/lib/terminal/historyActions'
import { historyScrollFor, terminalFor, terminalTextFor } from '@/lib/terminal/terminalHandles'
import type { InputMode } from '@/stores/app/settingsModel'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useBlocksStore } from '@/stores/terminal/blocksStore'
import { useHistorySearchStore } from '@/stores/terminal/historySearchStore'

type TerminalHandle = Pick<
  NonNullable<ReturnType<typeof terminalFor>>,
  'scrollLines' | 'scrollPages' | 'scrollToTop' | 'scrollToBottom'
>

export function registerTerminalCommands(): void {
  const blockStep = (id: CoreCommandId, dir: 'prev' | 'next'): void =>
    registerCore<undefined, { blockId: string | null }>({
      id,
      category: 'terminal',
      capabilities: ['drive-self'],
      run: (_args, ctx) => ({
        blockId: ctx.activePaneId ? stepBlock(ctx.activePaneId, dir) : null,
      }),
    })
  blockStep('block.selectPrev', 'prev')
  blockStep('block.selectNext', 'next')

  const scroll = (id: CoreCommandId, move: (term: TerminalHandle) => void): void =>
    registerCore<undefined, { scrolled: boolean }>({
      id,
      category: 'terminal',
      capabilities: ['drive-self'],
      run: (_args, ctx) => {
        const paneId = ctx.activePaneId
        const term = paneId ? (historyScrollFor(paneId) ?? terminalFor(paneId)) : undefined
        if (term) move(term)
        return { scrolled: term !== undefined }
      },
    })
  registerCore<undefined, { focused: boolean }>({
    id: 'terminal.reviewOutput',
    category: 'terminal',
    capabilities: ['drive-self'],
    run: (_args, ctx) => {
      const text = ctx.activePaneId ? terminalTextFor(ctx.activePaneId) : undefined
      text?.review()
      return { focused: text !== undefined }
    },
  })

  scroll('terminal.scrollToTop', (term) => term.scrollToTop())
  scroll('terminal.scrollToBottom', (term) => term.scrollToBottom())
  scroll('terminal.scrollPageUp', (term) => term.scrollPages(-1))
  scroll('terminal.scrollPageDown', (term) => term.scrollPages(1))
  scroll('terminal.scrollLineUp', (term) => term.scrollLines(-1))
  scroll('terminal.scrollLineDown', (term) => term.scrollLines(1))

  const blockCopy = (id: CoreCommandId, part: BlockPart): void =>
    registerCore<{ blockId?: string } | undefined, { copied: boolean }>({
      id,
      category: 'terminal',
      capabilities: ['drive-self'],
      run: async (args, ctx) => ({
        copied: ctx.activePaneId ? await copyBlock(ctx.activePaneId, part, args?.blockId) : false,
      }),
    })
  blockCopy('block.copyCommand', 'command')
  blockCopy('block.copyOutput', 'output')
  blockCopy('block.copyBoth', 'both')

  registerCore<{ blockId?: string } | undefined, { rerun: boolean }>({
    id: 'block.rerun',
    category: 'terminal',
    capabilities: ['shell'],
    run: (args, ctx) => ({
      rerun: ctx.activePaneId ? rerunBlock(ctx.activePaneId, args?.blockId) : false,
    }),
  })

  registerCore({
    id: 'history.search',
    category: 'terminal',
    target: 'none',
    run: () => useHistorySearchStore.getState().setOpen(true),
  })

  registerCore({
    id: 'snippets.search',
    category: 'snippets',
    target: 'none',
    run: (_args, ctx) => openSnippetPicker(ctx.activeWorkspaceId, ctx.activePaneId),
  })

  registerCore<void, { inputMode: InputMode }>({
    id: 'terminal.toggleInputEditor',
    category: 'terminal',
    target: 'none',
    capabilities: ['settings-write'],
    run: () => {
      const settings = useSettingsStore.getState()
      const inputMode = settings.behavior.inputMode === 'editor' ? 'terminal' : 'editor'
      settings.setBehavior({ inputMode })
      return { inputMode }
    },
  })

  registerCore<void, { cleared: boolean }>({
    id: 'terminal.clear',
    category: 'terminal',
    capabilities: ['shell'],
    run: async (_args, ctx) => {
      const paneId = ctx.activePaneId
      const term = paneId ? terminalFor(paneId) : undefined
      if (!paneId || !term) return { cleared: false }
      const atPrompt = !useBlocksStore.getState().running[paneId]
      return { cleared: await clearKeepingScrollback(term, atPrompt) }
    },
  })

  registerCore<void, { shown: boolean }>({
    id: 'terminal.showHistory',
    category: 'terminal',
    local: true,
    run: (_args, ctx) => {
      const paneId = ctx.activePaneId
      const term = paneId ? terminalFor(paneId) : undefined
      if (!paneId || !term) return { shown: false }
      showHistoryAboveLive(paneId)
      return { shown: true }
    },
  })

  registerCore<{ command: string }, { inserted: boolean }>({
    id: 'history.insert',
    hidden: true,
    capabilities: ['shell'],
    run: ({ command }, ctx) => ({
      inserted: ctx.activePaneId ? insertCommand(ctx.activePaneId, command) : false,
    }),
  })
}
