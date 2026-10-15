import { DropdownMenu, MenuItem } from '@/components/common/Menu'
import { Button } from '@/components/ui/button'
import { ContextMenuGroup } from '@/components/ui/context-menu'
import { fmt, useDict } from '@/lib/app/useDict'
import { DotsThreeIcon, KeyIcon } from '@phosphor-icons/react'
import type { ScriptTokenInfo, ScriptTokensState } from '@shared/permissions/scriptTokens'
import { CapsSummary, Dot, ExpiryBadge, ScopeSummary } from './TokenSummary'
import { runsCommands } from './tokenScope'
import { expiryText, lastUsedText } from './tokenText'

export function TokenRow({
  token,
  state,
  now,
  locale,
  onEdit,
  onDetails,
  onRevoke,
}: {
  token: ScriptTokenInfo
  state: ScriptTokensState
  now: number
  locale: string
  onEdit: () => void
  onDetails: () => void
  onRevoke: () => void
}): JSX.Element {
  const d = useDict()
  return (
    <li className="flex items-center gap-3 border-line border-b px-3 py-2.5 last:border-b-0">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-surface-2 text-fg-muted">
        <KeyIcon className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={onDetails}
            className="truncate text-fg text-ui-base hover:underline"
          >
            {token.name}
          </button>
          <ExpiryBadge token={token} now={now} />
        </div>
        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-fg-muted text-ui-sm">
          <span className="inline-flex flex-wrap items-center gap-x-0.5">
            <ScopeSummary scope={token.scope} state={state} />
          </span>
          <Dot />
          <CapsSummary caps={token.caps} />
          {runsCommands(token.caps) ? (
            <>
              <Dot />
              <span className="text-warn-fg">{d.scriptTokens.canRunCommands}</span>
            </>
          ) : null}
          <Dot />
          <span>{expiryText(d, token, now)}</span>
        </div>
      </div>
      <div className="shrink-0 text-right text-ui-sm">
        <div className="text-fg-dim text-ui-xs">{d.scriptTokens.lastUsed}</div>
        <div className="text-fg-muted">{lastUsedText(d, token.lastUsedAt, now, locale)}</div>
      </div>
      <Button
        variant="ghost"
        size="sm"
        aria-label={fmt(d.scriptTokens.editToken, { name: token.name })}
        onClick={onEdit}
      >
        {d.scriptTokens.edit}
      </Button>
      <DropdownMenu
        trigger={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={fmt(d.scriptTokens.more, { name: token.name })}
          >
            <DotsThreeIcon />
          </Button>
        }
      >
        <ContextMenuGroup>
          <MenuItem onClick={onDetails}>{d.scriptTokens.viewDetails}</MenuItem>
          <MenuItem className="text-attn-fg" onClick={onRevoke}>
            {d.scriptTokens.revoke}
          </MenuItem>
        </ContextMenuGroup>
      </DropdownMenu>
    </li>
  )
}
