import { PlusIcon, XIcon } from '@phosphor-icons/react'
import type { ScriptTokensState } from '@shared/permissions/scriptTokens'
import type { JSX } from 'react'
import { DropdownMenu, MenuItem, MenuLabel } from '@/components/common/Menu'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ContextMenuGroup } from '@/components/ui/context-menu'
import { Label } from '@/components/ui/label'
import { fmt, useDict } from '@/lib/app/useDict'
import { GroupDot } from './TokenSummary'
import { groupSize } from './tokenScope'

function ScopeChip({
  label,
  color,
  showDot,
  onRemove,
  removeLabel,
}: {
  label: string
  color?: string
  showDot: boolean
  onRemove: () => void
  removeLabel: string
}): JSX.Element {
  return (
    <span className="inline-flex h-6 items-center gap-1.5 rounded-full bg-surface-2 pr-1 pl-2.5 text-fg text-ui-sm">
      {showDot ? <GroupDot color={color} /> : null}
      {label}
      <button
        type="button"
        aria-label={removeLabel}
        onClick={onRemove}
        className="flex size-4 items-center justify-center rounded-full text-fg-muted hover:bg-surface-3 hover:text-fg"
      >
        <XIcon className="size-4" />
      </button>
    </span>
  )
}

export function ScopePicker({
  groups,
  workspaces,
  own,
  state,
  onChange,
}: {
  groups: string[]
  workspaces: string[]
  own: boolean
  state: ScriptTokensState
  onChange: (next: { groups?: string[]; workspaces?: string[]; own?: boolean }) => void
}): JSX.Element {
  const d = useDict()
  const freeGroups = state.groups.filter((g) => !groups.includes(g.id))
  const freeWorkspaces = state.workspaces.filter((w) => !workspaces.includes(w.id))
  return (
    <div className="mt-2 flex flex-col gap-2 pl-6">
      <div className="flex flex-wrap items-center gap-1.5">
        {groups.map((id) => {
          const group = state.groups.find((g) => g.id === id)
          const name = group
            ? `${fmt(d.scriptTokens.groupChip, { name: group.name })} · ${groupSize(id, state)}`
            : d.scriptTokens.deleted
          return (
            <ScopeChip
              key={`g:${id}`}
              label={name}
              color={group?.color}
              showDot
              removeLabel={fmt(d.scriptTokens.removeChip, { name: group?.name ?? id })}
              onRemove={() => onChange({ groups: groups.filter((g) => g !== id) })}
            />
          )
        })}
        {workspaces.map((id) => {
          const ws = state.workspaces.find((w) => w.id === id)
          return (
            <ScopeChip
              key={`w:${id}`}
              label={
                ws ? fmt(d.scriptTokens.workspaceChip, { name: ws.name }) : d.scriptTokens.deleted
              }
              showDot={false}
              removeLabel={fmt(d.scriptTokens.removeChip, { name: ws?.name ?? id })}
              onRemove={() => onChange({ workspaces: workspaces.filter((w) => w !== id) })}
            />
          )
        })}
        <DropdownMenu
          align="start"
          trigger={
            <Button variant="outline" size="xs" className="rounded-full border-dashed">
              <PlusIcon data-icon="inline-start" />
              {d.scriptTokens.add}
            </Button>
          }
        >
          {freeGroups.length === 0 && freeWorkspaces.length === 0 ? (
            <ContextMenuGroup>
              <MenuLabel>{d.scriptTokens.nothingToAdd}</MenuLabel>
            </ContextMenuGroup>
          ) : null}
          {freeGroups.length > 0 ? (
            <ContextMenuGroup>
              <MenuLabel>{d.scriptTokens.groups}</MenuLabel>
              {freeGroups.map((g) => (
                <MenuItem
                  key={g.id}
                  leading={<GroupDot color={g.color} />}
                  hint={String(groupSize(g.id, state))}
                  onClick={() => onChange({ groups: [...groups, g.id] })}
                >
                  {g.name}
                </MenuItem>
              ))}
            </ContextMenuGroup>
          ) : null}
          {freeWorkspaces.length > 0 ? (
            <ContextMenuGroup>
              <MenuLabel>{d.scriptTokens.workspaces}</MenuLabel>
              {freeWorkspaces.map((w) => (
                <MenuItem
                  key={w.id}
                  onClick={() => onChange({ workspaces: [...workspaces, w.id] })}
                >
                  {w.name}
                </MenuItem>
              ))}
            </ContextMenuGroup>
          ) : null}
        </DropdownMenu>
      </div>
      <Label className="flex items-center gap-2 font-normal text-fg-muted text-ui-sm">
        <Checkbox
          checked={own}
          onCheckedChange={(checked) => onChange({ own: checked === true })}
        />
        {d.scriptTokens.accessOwn}
      </Label>
    </div>
  )
}
