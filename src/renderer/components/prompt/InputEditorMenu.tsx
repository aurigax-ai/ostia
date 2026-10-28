import type { CommandSuggestion } from '@aurigax-ai/ostia-extension-sdk/contract/assist'
import type { ReactNode, RefObject } from 'react'
import { Command, CommandItem, CommandList } from '@/components/ui/command'
import { useDict } from '@/lib/app/useDict'
import { completionLabel, markRuns } from '@/lib/prompt/completionMatch'
import type { CompletionItem } from '@/lib/prompt/inputEditor'
import type { Menu } from './useInputDraft'
import type { NaturalCommands } from './useInputSuggestions'

function highlightedName(label: string, marks: readonly number[]): ReactNode[] {
  return markRuns(label, marks).map((run) =>
    run.marked ? (
      <span key={run.at} className="input-editor-menu-match">
        {run.text}
      </span>
    ) : (
      <span key={run.at}>{run.text}</span>
    ),
  )
}

export function InputEditorMenu({
  menuRef,
  popoverAbove,
  fontFamily,
  menuShown,
  naturalOpen,
  tipText,
  fileHint,
  setMenu,
  setNatural,
  pick,
  pickNatural,
}: {
  menuRef: RefObject<HTMLDivElement>
  popoverAbove: boolean
  fontFamily: string
  menuShown: Menu | null
  naturalOpen: NaturalCommands | null
  tipText: string | null
  fileHint: string | null
  setMenu: (next: Menu | null) => void
  setNatural: (next: NaturalCommands | null) => void
  pick: (item: CompletionItem) => void
  pickNatural: (item: CommandSuggestion) => void
}): JSX.Element | null {
  const d = useDict()
  if (!menuShown && !tipText && !naturalOpen) return null
  return (
    <div ref={menuRef} className="input-editor-menu" data-side={popoverAbove ? 'top' : 'bottom'}>
      {menuShown ? (
        <Command
          shouldFilter={false}
          value={completionLabel(menuShown.matches[menuShown.index].item)}
          onValueChange={(value) => {
            const index = menuShown.matches.findIndex(
              (match) => completionLabel(match.item) === value,
            )
            if (index >= 0 && index !== menuShown.index) setMenu({ ...menuShown, index })
          }}
          onMouseDown={(e) => e.preventDefault()}
          className="h-auto rounded-md! border shadow-md"
          style={{ fontFamily }}
        >
          <CommandList label={d.inputEditor.completions}>
            {menuShown.matches.map(({ item, marks }) => (
              <CommandItem
                key={completionLabel(item)}
                value={completionLabel(item)}
                className="input-editor-menu-item"
                onSelect={() => pick(item)}
              >
                <span className="input-editor-menu-name">
                  {highlightedName(completionLabel(item), marks)}
                </span>
                {item.description ? (
                  <span className="input-editor-menu-description">{item.description}</span>
                ) : null}
              </CommandItem>
            ))}
          </CommandList>
          {fileHint ? (
            <p className="input-editor-tip m-1" aria-live="polite">
              {fileHint}
            </p>
          ) : null}
        </Command>
      ) : naturalOpen ? (
        <Command
          shouldFilter={false}
          value={naturalOpen.items[naturalOpen.index]?.command}
          onValueChange={(value) => {
            const index = naturalOpen.items.findIndex((item) => item.command === value)
            if (index >= 0 && index !== naturalOpen.index) {
              setNatural({ ...naturalOpen, index })
            }
          }}
          onMouseDown={(e) => e.preventDefault()}
          className="h-auto rounded-md! border shadow-md"
          style={{ fontFamily }}
        >
          <CommandList label={d.assist.suggestions}>
            {naturalOpen.items.map((item) => (
              <CommandItem
                key={item.command}
                value={item.command}
                className="input-editor-menu-item"
                onSelect={() => pickNatural(item)}
              >
                <span className="input-editor-menu-name">{item.command}</span>
                {item.description ? (
                  <span className="input-editor-menu-description">{item.description}</span>
                ) : null}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      ) : (
        <p className="input-editor-tip" aria-live="polite">
          {tipText}
        </p>
      )}
    </div>
  )
}
