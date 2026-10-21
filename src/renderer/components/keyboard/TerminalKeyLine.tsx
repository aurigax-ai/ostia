import { ArrowCounterClockwiseIcon, XIcon } from '@phosphor-icons/react'
import { chordText } from '@shared/keyboard/chordSpec'
import { useState } from 'react'
import { IconButton } from '@/components/common/IconButton'
import { Notice } from '@/components/common/Notice'
import { Kbd } from '@/components/ui/kbd'
import { TableCell, TableRow } from '@/components/ui/table'
import { fmt, useDict } from '@/lib/app/useDict'
import { terminalKeyConflicts } from '@/lib/keyboard/chords'
import { removeTerminalKey, resetTerminalKey } from '@/lib/keyboard/keyPresets'
import type { TerminalKeySources } from '@/lib/keyboard/keySources'
import { isMac } from '@/platform'
import { RowToggle, TerminalKeyDetail } from './BindingDetail'
import { CustomBar, DesktopNote, SourceLabel } from './KeyRowNotes'
import { commandTitle, sendActionText, sendText } from './keyboardLabels'
import { useCollapse } from './keyRows'
import { TerminalKeyEditor } from './TerminalKeyEditor'

export function TerminalKeyLine({
  entry,
  presetName,
  expanded = false,
  onToggle = () => {},
}: {
  entry: TerminalKeySources
  presetName: string | null
  expanded?: boolean
  onToggle?: () => void
}): JSX.Element {
  const d = useDict()
  const [editing, setEditing] = useState(false)
  const { row } = entry
  const keys = chordText(row.spec, isMac)
  const shadowedBy = terminalKeyConflicts(row.spec, isMac)[0]
  const action = sendActionText(row.send, d)
  const detailId = `terminal-key-detail-${row.signature}`
  const { toggleRef, toggle, collapse } = useCollapse(expanded, onToggle, () => setEditing(false))
  if (editing) {
    return (
      <TableRow className="hover:bg-transparent">
        <TableCell colSpan={3} className="py-1.5 whitespace-normal">
          <TerminalKeyEditor previous={row} onDone={() => setEditing(false)} />
        </TableCell>
      </TableRow>
    )
  }
  const editor = (
    <>
      <span className="group/chip inline-flex items-center gap-0.5">
        <button
          type="button"
          className="rounded-sm"
          aria-label={fmt(d.keyboard.editFor, { keys })}
          onClick={() => setEditing(true)}
        >
          <Kbd className="text-fg">{keys}</Kbd>
        </button>
        <IconButton
          icon={XIcon}
          label={fmt(d.keyboard.removeFor, { keys })}
          className={
            expanded
              ? undefined
              : 'text-fg-dim opacity-0 group-hover/chip:opacity-100 focus-visible:opacity-100'
          }
          onClick={() => removeTerminalKey(row, isMac)}
        />
      </span>
      {shadowedBy ? (
        <Notice>{fmt(d.keyboard.shadowed, { command: commandTitle(shadowedBy, d) })}</Notice>
      ) : null}
      <DesktopNote specs={[row.spec]} />
    </>
  )
  return (
    <>
      <TableRow
        data-source={entry.label ?? 'default'}
        data-expanded={expanded || undefined}
        className="group/row hover:bg-surface-2"
      >
        <TableCell className="relative py-1.5 pl-3 align-top whitespace-normal">
          <CustomBar on={entry.label === 'user'} />
          <RowToggle
            label={fmt(d.keyboard.detailsFor, { command: keys })}
            expanded={expanded}
            controls={detailId}
            onToggle={toggle}
            onCollapse={collapse}
            toggleRef={toggleRef}
          >
            {action ? (
              <>
                <div className="truncate text-fg text-ui-base">{action}</div>
                <div className="truncate font-mono text-fg-muted text-ui-xs">
                  {sendText(row.send)}
                </div>
              </>
            ) : (
              <>
                <div className="truncate font-mono text-fg text-ui-base">{sendText(row.send)}</div>
                <div className="truncate text-fg-muted text-ui-xs">
                  {d.keyboard.sendTypes[row.send.type]}
                </div>
              </>
            )}
          </RowToggle>
        </TableCell>
        <TableCell className="py-1.5 align-top whitespace-normal">
          {expanded ? <Kbd className="text-fg">{keys}</Kbd> : editor}
        </TableCell>
        <TableCell className="py-1.5 align-top whitespace-normal">
          <div className="flex items-center gap-1">
            <div className="flex min-w-0 flex-1 flex-col">
              <SourceLabel label={entry.label} presetName={presetName} />
            </div>
            {row.preset && row.userKey ? (
              <IconButton
                icon={ArrowCounterClockwiseIcon}
                label={fmt(d.keyboard.resetFor, { command: keys })}
                onClick={() => resetTerminalKey(row, isMac)}
              />
            ) : null}
          </div>
        </TableCell>
      </TableRow>
      {expanded ? (
        <TerminalKeyDetail
          id={detailId}
          keys={keys}
          entry={entry}
          presetName={presetName}
          active={editor}
          onCollapse={collapse}
          onBack={() => resetTerminalKey(row, isMac)}
          onUnbind={() => {
            collapse()
            removeTerminalKey(row, isMac)
          }}
        />
      ) : null}
    </>
  )
}
