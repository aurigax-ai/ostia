import { DropdownMenu, MenuItem, MenuLabel } from '@/components/common/Menu'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ContextMenuGroup } from '@/components/ui/context-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { fmt, useDict } from '@/i18n/useDict'
import { readPref, writePref } from '@/lib/app/localPrefs'
import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/stores/app/settingsStore'
import {
  CaretLeftIcon,
  CheckIcon,
  CopyIcon,
  DotsThreeIcon,
  InfoIcon,
  KeyIcon,
  PlusIcon,
  WarningIcon,
  XIcon,
} from '@phosphor-icons/react'
import type { Dict } from '@shared/app/dict'
import type { Capability } from '@shared/capabilities'
import { type RelativeStep, formatRelative } from '@shared/common/relativeTime'
import {
  DEFAULT_TOKEN_EXPIRY,
  NEVER_EXPIRES,
  SCRIPT_TOKEN_PRESETS,
  SCRIPT_TOKEN_RUN_CAPS,
  SCRIPT_TOKEN_UI_CAPS,
  type ScriptTokenInfo,
  type ScriptTokenSaveResult,
  type ScriptTokenScope,
  type ScriptTokenUiCap,
  type ScriptTokenUpdateInput,
  type ScriptTokensState,
} from '@shared/permissions/scriptTokens'
import { Fragment, type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { SectionHead, SelectField, SettingsGroup } from './SettingsPanel'

const ENV = 'OSTIA_TOKEN'
const DISMISSED_KEY = 'scriptTokens.retiredDismissedAt'
const DAY_MS = 86_400_000
const SOON_DAYS = 7
const NAME_PATTERN = /^[\w .@-]{1,60}$/
const EMPTY: ScriptTokensState = { tokens: [], retired: [], workspaces: [], groups: [] }
const RELATIVE_STEPS: RelativeStep[] = [
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
]
const EXAMPLE = 'ostia pane list --json'

type ExpiryChoice = '7d' | '30d' | '90d' | '1y' | 'custom' | 'never' | 'keep'
type Preset = keyof typeof SCRIPT_TOKEN_PRESETS | 'custom'
type Shown = { title: string; value: string; token: ScriptTokenInfo }

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function localDate(iso: string): string {
  const at = new Date(iso)
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

function localTime(iso: string): string {
  const at = new Date(iso)
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
}

function daysUntil(iso: string, now: number): number {
  return Math.ceil((Date.parse(iso) - now) / DAY_MS)
}

function expiryState(t: ScriptTokenInfo, now: number): 'never' | 'expired' | 'soon' | 'later' {
  if (t.expiresAt === null) return 'never'
  const left = Date.parse(t.expiresAt) - now
  if (left <= 0) return 'expired'
  return left <= SOON_DAYS * DAY_MS ? 'soon' : 'later'
}

function expiryText(d: Dict, t: ScriptTokenInfo, now: number): string {
  const state = expiryState(t, now)
  if (state === 'never' || t.expiresAt === null) return d.scriptTokens.neverExpires
  if (state === 'expired') return d.scriptTokens.expired
  if (state === 'soon') return fmt(d.scriptTokens.expiresIn, { n: daysUntil(t.expiresAt, now) })
  return fmt(d.scriptTokens.expiresOn, { date: localDate(t.expiresAt) })
}

function lastUsedText(d: Dict, iso: string | null, now: number, locale: string): string {
  if (!iso) return d.scriptTokens.neverUsed
  const seconds = Math.round((Date.parse(iso) - now) / 1000)
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  return formatRelative(Math.abs(seconds) >= 60 ? seconds : 0, RELATIVE_STEPS, format)
}

function shownCaps(caps: readonly Capability[]): ScriptTokenUiCap[] {
  return SCRIPT_TOKEN_UI_CAPS.filter((cap) => caps.includes(cap))
}

function runsCommands(caps: readonly Capability[]): boolean {
  return caps.some((cap) => SCRIPT_TOKEN_RUN_CAPS.includes(cap))
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v) => b.includes(v))
}

function presetOf(caps: readonly Capability[]): Preset {
  if (sameSet(caps, SCRIPT_TOKEN_PRESETS.readonly)) return 'readonly'
  if (sameSet(caps, SCRIPT_TOKEN_PRESETS.coordinator)) return 'coordinator'
  return 'custom'
}

function sameScope(a: ScriptTokenScope, b: ScriptTokenScope): boolean {
  if (a.kind === 'all' || b.kind === 'all') return a.kind === b.kind
  return (
    sameSet(a.groups, b.groups) &&
    sameSet(a.workspaces, b.workspaces) &&
    a.ownWorkspaces === b.ownWorkspaces
  )
}

function knownScope(scope: ScriptTokenScope, state: ScriptTokensState): ScriptTokenScope {
  if (scope.kind === 'all') return scope
  return {
    kind: 'limited',
    groups: scope.groups.filter((id) => state.groups.some((g) => g.id === id)),
    workspaces: scope.workspaces.filter((id) => state.workspaces.some((w) => w.id === id)),
    ownWorkspaces: scope.ownWorkspaces,
  }
}

function groupSize(groupId: string, state: ScriptTokensState): number {
  return state.workspaces.filter((w) => w.groupId === groupId).length
}

function reachedCount(scope: ScriptTokenScope, state: ScriptTokensState): number {
  if (scope.kind === 'all') return state.workspaces.length
  return state.workspaces.filter(
    (w) => scope.workspaces.includes(w.id) || (w.groupId && scope.groups.includes(w.groupId)),
  ).length
}

function reachText(d: Dict, caps: readonly Capability[], n: number): string {
  return fmt(runsCommands(caps) ? d.scriptTokens.reachRun : d.scriptTokens.reachRead, { n })
}

function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function masked(value: string): string {
  return value.length > 16 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value
}

function failureText(d: Dict, res: Extract<ScriptTokenSaveResult, { ok: false }>): string {
  if (res.presence === 'cancelled') return d.scriptTokens.authCancelled
  if (res.presence === 'polkit-agent') return d.scriptTokens.authNoAgent
  if (res.presence === 'refused') {
    return fmt(d.scriptTokens.authFailed, { detail: res.error.replace(/^presence-\w+: /, '') })
  }
  return fmt(d.scriptTokens.saveFailed, { error: res.error })
}

function GroupDot({ color }: { color?: string }): JSX.Element {
  return (
    <span
      aria-hidden
      className="inline-block size-2 shrink-0 rounded-full bg-fg-muted"
      style={color ? { background: `var(--group-${color})` } : undefined}
    />
  )
}

function ScopeSummary({
  scope,
  state,
}: {
  scope: ScriptTokenScope
  state: ScriptTokensState
}): JSX.Element {
  const d = useDict()
  if (scope.kind === 'all') return <span>{d.scriptTokens.accessAll}</span>
  const parts: ReactNode[] = [
    ...scope.groups.map((id) => {
      const group = state.groups.find((g) => g.id === id)
      return (
        <span key={`g:${id}`} className="inline-flex items-center gap-1">
          <GroupDot color={group?.color} />
          {group?.name ?? d.scriptTokens.deleted}
        </span>
      )
    }),
    ...scope.workspaces.map((id) => {
      const ws = state.workspaces.find((w) => w.id === id)
      return (
        <span key={`w:${id}`}>
          {ws ? fmt(d.scriptTokens.workspaceChip, { name: ws.name }) : d.scriptTokens.deleted}
        </span>
      )
    }),
  ]
  return (
    <>
      {parts.map((part, i) => (
        <Fragment key={(part as JSX.Element).key}>
          {i > 0 ? d.scriptTokens.listSep : null}
          {part}
        </Fragment>
      ))}
    </>
  )
}

function CapsSummary({ caps }: { caps: readonly Capability[] }): JSX.Element {
  const d = useDict()
  const shown = shownCaps(caps)
  if (shown.length > 2)
    return <span>{fmt(d.scriptTokens.permissionCount, { n: shown.length })}</span>
  return (
    <span>{shown.map((cap) => d.scriptTokens.caps[cap].label).join(d.scriptTokens.listSep)}</span>
  )
}

function Dot(): JSX.Element {
  return (
    <span aria-hidden className="text-fg-dim">
      ·
    </span>
  )
}

function ExpiryBadge({ token, now }: { token: ScriptTokenInfo; now: number }): JSX.Element | null {
  const d = useDict()
  const state = expiryState(token, now)
  if (state !== 'soon' && state !== 'expired') return null
  return (
    <Badge
      variant="outline"
      className={cn(
        'h-4 rounded-sm px-1 text-ui-xs',
        state === 'soon' ? 'border-warn-fg/40 text-warn-fg' : 'border-attn-fg/40 text-attn-fg',
      )}
    >
      {state === 'soon' ? d.scriptTokens.expiresSoon : d.scriptTokens.expired}
    </Badge>
  )
}

function TokenRow({
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

function CodeBlock({ lines }: { lines: string[] }): JSX.Element {
  return (
    <pre className="overflow-x-auto rounded-md border border-line bg-bg-sunken px-3 py-2 font-mono text-fg text-ui-sm">
      {lines.map((line) => (
        <div key={line}>
          <span className="select-none text-fg-dim">$ </span>
          {line}
        </div>
      ))}
    </pre>
  )
}

function RetiredBanner({
  state,
  onDismiss,
}: {
  state: ScriptTokensState
  onDismiss: () => void
}): JSX.Element {
  const d = useDict()
  return (
    <output className="mb-4 flex items-start gap-3 rounded-md border border-warn-fg/40 bg-warn-fg/10 px-3 py-2.5 text-warn-fg">
      <WarningIcon className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1 text-ui-sm">
        <div className="font-medium">
          {fmt(d.scriptTokens.retiredTitle, { n: state.retired.length })}
        </div>
        <div>
          {fmt(d.scriptTokens.retiredBody, {
            names: state.retired.map((r) => r.name).join(d.scriptTokens.listSep),
            env: ENV,
          })}
        </div>
      </div>
      <Button variant="ghost" size="sm" className="text-warn-fg" onClick={onDismiss}>
        {d.scriptTokens.dismiss}
      </Button>
    </output>
  )
}

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
        <XIcon className="size-3" />
      </button>
    </span>
  )
}

function ScopePicker({
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

function TokenDialog({
  token,
  state,
  onClose,
  onSaved,
}: {
  token: ScriptTokenInfo | null
  state: ScriptTokensState
  onClose: () => void
  onSaved: (res: Extract<ScriptTokenSaveResult, { ok: true }>, regenerated: boolean) => void
}): JSX.Element {
  const d = useDict()
  const t = d.scriptTokens
  const now = Date.now()
  const editing = token !== null
  const [name, setName] = useState(token?.name ?? '')
  const [caps, setCaps] = useState<Capability[]>(() =>
    token ? shownCaps(token.caps) : [...SCRIPT_TOKEN_PRESETS.readonly],
  )
  const [kind, setKind] = useState<ScriptTokenScope['kind']>(token?.scope.kind ?? 'limited')
  const [groups, setGroups] = useState<string[]>(
    token?.scope.kind === 'limited' ? token.scope.groups : [],
  )
  const [workspaces, setWorkspaces] = useState<string[]>(
    token?.scope.kind === 'limited' ? token.scope.workspaces : [],
  )
  const [own, setOwn] = useState(token?.scope.kind === 'limited' && token.scope.ownWorkspaces)
  const [expiry, setExpiry] = useState<ExpiryChoice>(
    token && expiryState(token, now) !== 'expired'
      ? 'keep'
      : (DEFAULT_TOKEN_EXPIRY as ExpiryChoice),
  )
  const [customDate, setCustomDate] = useState('')
  const [askNever, setAskNever] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const scope: ScriptTokenScope =
    kind === 'all' ? { kind: 'all' } : { kind: 'limited', groups, workspaces, ownWorkspaces: own }
  const sendScope = knownScope(scope, state)
  const trimmed = name.trim()
  const nameChanged = !editing || trimmed !== token.name
  const capsChanged = editing && !sameSet(caps, shownCaps(token.caps))
  const scopeChanged = editing && !sameScope(scope, token.scope)
  const expiryChanged = expiry !== 'keep'
  const regenerates = !editing || capsChanged || scopeChanged || expiryChanged
  const scopeEmpty =
    sendScope.kind === 'limited' && sendScope.groups.length + sendScope.workspaces.length === 0
  const valid =
    NAME_PATTERN.test(trimmed) &&
    caps.length > 0 &&
    !scopeEmpty &&
    (expiry !== 'custom' || /^\d{4}-\d{2}-\d{2}$/.test(customDate))
  const changed = !editing || nameChanged || regenerates
  const reach = reachText(d, caps, reachedCount(sendScope, state))
  const preset = presetOf(caps)

  const expiryOptions: { value: ExpiryChoice; label: string }[] = [
    ...(editing && expiryState(token, now) !== 'expired'
      ? [
          {
            value: 'keep' as const,
            label: fmt(t.keepExpiry, {
              when: token.expiresAt ? localDate(token.expiresAt) : t.neverExpires,
            }),
          },
        ]
      : []),
    { value: '7d', label: fmt(t.days, { n: 7 }) },
    { value: '30d', label: fmt(t.days, { n: 30 }) },
    { value: '90d', label: fmt(t.days, { n: 90 }) },
    { value: '1y', label: t.oneYear },
    { value: 'custom', label: t.customDate },
    { value: 'never', label: t.neverExpires },
  ]

  const send = async (choice: ExpiryChoice): Promise<void> => {
    setBusy(true)
    setError(null)
    const expires = choice === 'custom' ? customDate : choice
    const never = expires === NEVER_EXPIRES ? { confirmNeverExpires: true } : {}
    let res: ScriptTokenSaveResult
    if (!token) {
      res = await window.ostia.scriptTokens.create({
        name: trimmed,
        caps,
        scope: sendScope,
        expires,
        ...never,
      })
    } else {
      const input: ScriptTokenUpdateInput = { id: token.id, ifUpdatedAt: token.updatedAt }
      if (nameChanged) input.name = trimmed
      if (capsChanged) input.caps = caps
      if (scopeChanged) input.scope = sendScope
      if (choice !== 'keep') Object.assign(input, { expires, ...never })
      res = await window.ostia.scriptTokens.update(input)
    }
    setBusy(false)
    if (res.ok) onSaved(res, regenerates)
    else setError(failureText(d, res))
  }

  const submit = (): void => {
    if (!valid || !changed || busy) return
    if (regenerates && expiry === 'never') {
      setAskNever(true)
      return
    }
    void send(expiry)
  }

  const toggleCap = (cap: Capability, on: boolean): void =>
    setCaps((list) => SCRIPT_TOKEN_UI_CAPS.filter((c) => (c === cap ? on : list.includes(c))))

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {editing ? fmt(t.editTitle, { name: token.name }) : t.dialogTitle}
          </DialogTitle>
          <DialogDescription>{t.dialogDesc}</DialogDescription>
        </DialogHeader>
        <form
          id="script-token-form"
          className="-mx-4 flex max-h-[62vh] flex-col gap-4 overflow-y-auto px-4"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <div className="grid grid-cols-[1fr_14rem] gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="script-token-name" className="text-ui-sm">
                {t.name}
              </Label>
              <Input
                id="script-token-name"
                value={name}
                maxLength={60}
                autoComplete="off"
                spellCheck={false}
                placeholder="ostia-ceo"
                aria-invalid={name !== '' && !NAME_PATTERN.test(trimmed)}
                onChange={(e) => setName(e.target.value)}
                className="h-7 text-ui-sm"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="font-medium text-ui-sm">{t.expiration}</span>
              <div
                className={cn(
                  expiry === 'never' &&
                    '[&_[data-slot=select-trigger]]:border-warn-fg [&_[data-slot=select-trigger]]:text-warn-fg',
                )}
              >
                <SelectField
                  value={expiry}
                  onChange={setExpiry}
                  options={expiryOptions}
                  label={t.expiration}
                  width="w-full"
                />
              </div>
              {expiry === 'custom' ? (
                <Input
                  type="date"
                  aria-label={t.customDate}
                  value={customDate}
                  min={localDate(new Date(now + DAY_MS).toISOString())}
                  onChange={(e) => setCustomDate(e.target.value)}
                  className="h-7 text-ui-sm"
                />
              ) : null}
            </div>
          </div>
          {expiry === 'never' ? (
            <p className="flex items-start gap-2 rounded-md border border-warn-fg/40 bg-warn-fg/10 px-3 py-2 text-ui-sm text-warn-fg">
              <WarningIcon className="mt-0.5 size-3.5 shrink-0" />
              {t.neverWarn}
            </p>
          ) : null}

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 font-medium text-fg text-ui-sm">{t.access}</legend>
            <RadioGroup
              value={kind}
              onValueChange={(v) => setKind(v as ScriptTokenScope['kind'])}
              className="gap-2"
            >
              <Label
                className={cn(
                  'flex cursor-pointer flex-col items-stretch gap-0 rounded-md border border-line px-3 py-2.5 font-normal',
                  kind === 'all' && 'border-brand',
                )}
              >
                <span className="flex items-center gap-2">
                  <RadioGroupItem value="all" />
                  <span className="text-fg text-ui-base">{t.accessAll}</span>
                </span>
                <span className="pl-6 text-fg-muted text-ui-sm">{t.accessAllDesc}</span>
              </Label>
              <div
                className={cn(
                  'rounded-md border border-line px-3 py-2.5',
                  kind === 'limited' && 'border-brand',
                )}
              >
                <Label className="flex cursor-pointer items-center gap-2 font-normal">
                  <RadioGroupItem value="limited" />
                  <span className="text-fg text-ui-base">{t.accessSelected}</span>
                </Label>
                {kind === 'limited' ? (
                  <ScopePicker
                    groups={groups}
                    workspaces={workspaces}
                    own={own}
                    state={state}
                    onChange={(next) => {
                      if (next.groups) setGroups(next.groups)
                      if (next.workspaces) setWorkspaces(next.workspaces)
                      if (next.own !== undefined) setOwn(next.own)
                    }}
                  />
                ) : null}
              </div>
            </RadioGroup>
            {kind === 'limited' && scopeEmpty ? (
              <p className="text-fg-muted text-ui-sm">{t.accessNone}</p>
            ) : null}
          </fieldset>

          <fieldset aria-label={t.permissions} className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3">
              <span className="font-medium text-fg text-ui-sm">{t.permissions}</span>
              <div className="flex rounded-md bg-surface-2 p-0.5">
                {(
                  [
                    ['readonly', t.presetReadonly],
                    ['coordinator', t.presetCoordinator],
                    ['custom', t.presetCustom],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={preset === id}
                    onClick={() => {
                      if (id !== 'custom') setCaps([...SCRIPT_TOKEN_PRESETS[id]])
                    }}
                    className={cn(
                      'h-6 rounded-sm px-2.5 text-fg-muted text-ui-sm',
                      preset === id && 'bg-surface-1 text-fg shadow-xs',
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-x-6 rounded-md border border-line px-3 py-1">
              {SCRIPT_TOKEN_UI_CAPS.map((cap) => (
                <Label
                  key={cap}
                  className="flex cursor-pointer items-start gap-2.5 border-line border-b py-2 font-normal"
                >
                  <Checkbox
                    className="mt-0.5"
                    checked={caps.includes(cap)}
                    onCheckedChange={(checked) => toggleCap(cap, checked === true)}
                  />
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-1.5 text-fg text-ui-base">
                      {t.caps[cap].label}
                      {SCRIPT_TOKEN_RUN_CAPS.includes(cap) ? (
                        <Badge
                          variant="outline"
                          className="h-4 rounded-sm border-warn-fg/40 px-1 text-ui-xs text-warn-fg"
                        >
                          {t.canRunCommands}
                        </Badge>
                      ) : null}
                    </span>
                    <span className="block text-fg-muted text-ui-sm">{t.caps[cap].desc}</span>
                  </span>
                </Label>
              ))}
            </div>
            {caps.length === 0 ? (
              <p className="text-fg-muted text-ui-sm">{t.permissionsNone}</p>
            ) : null}
          </fieldset>
          {editing && changed ? (
            <p
              className={cn(
                'flex items-start gap-2 text-ui-sm',
                regenerates ? 'text-warn-fg' : 'text-fg-muted',
              )}
            >
              {regenerates ? <WarningIcon className="mt-0.5 size-3.5 shrink-0" /> : null}
              {regenerates ? t.regenerateNote : t.renameNote}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-attn-fg text-ui-sm">
              {error}
            </p>
          ) : null}
        </form>
        <DialogFooter className="items-center sm:justify-between">
          <span className="text-fg-muted text-ui-sm">{sentence(reach)}</span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={busy} onClick={onClose}>
              {t.cancel}
            </Button>
            <Button
              type="submit"
              form="script-token-form"
              size="sm"
              disabled={!valid || !changed || busy}
            >
              {!editing ? t.generateToken : regenerates ? t.saveRegenerate : t.save}
            </Button>
          </div>
        </DialogFooter>
        <AlertDialog open={askNever} onOpenChange={setAskNever}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t.neverConfirmTitle}</AlertDialogTitle>
              <AlertDialogDescription>
                {fmt(t.neverConfirmBody, { name: trimmed, reach })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel
                size="sm"
                onClick={() => {
                  setAskNever(false)
                  setExpiry('90d')
                  void send('90d')
                }}
              >
                {t.neverConfirmShorter}
              </AlertDialogCancel>
              <AlertDialogAction
                size="sm"
                className="bg-warn-fg text-bg hover:bg-warn-fg/90"
                onClick={() => {
                  setAskNever(false)
                  void send(NEVER_EXPIRES)
                }}
              >
                {t.neverConfirmKeep}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  )
}

function ShownDialog({
  shown,
  state,
  onClose,
}: {
  shown: Shown
  state: ScriptTokensState
  onClose: () => void
}): JSX.Element {
  const d = useDict()
  const t = d.scriptTokens
  const [copied, setCopied] = useState(false)
  const { token, value } = shown
  const caps = shownCaps(token.caps)
  return (
    <Dialog
      open
      disablePointerDismissal
      onOpenChange={(open, details) => {
        if (!open) details.cancel()
      }}
    >
      <DialogContent className="sm:max-w-2xl" showCloseButton={false}>
        <DialogHeader className="flex-row items-start gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-surface-2 text-brand">
            <CheckIcon className="size-4" />
          </span>
          <div className="flex flex-col gap-1.5">
            <DialogTitle>{shown.title}</DialogTitle>
            <DialogDescription>{t.copyNow}</DialogDescription>
          </div>
        </DialogHeader>
        <div className="flex gap-2">
          <Input
            readOnly
            aria-label={t.tokenValue}
            value={value}
            onFocus={(e) => e.currentTarget.select()}
            className="h-8 font-mono text-ui-sm"
          />
          <Button
            variant="outline"
            size="sm"
            className="h-8"
            onClick={() => void navigator.clipboard.writeText(value).then(() => setCopied(true))}
          >
            {copied ? (
              <CheckIcon data-icon="inline-start" />
            ) : (
              <CopyIcon data-icon="inline-start" />
            )}
            {copied ? t.copied : t.copy}
          </Button>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <Stat label={t.access}>
            <span className="inline-flex flex-wrap items-center gap-x-0.5">
              <ScopeSummary scope={token.scope} state={state} />
              {` (${reachedCount(token.scope, state)})`}
            </span>
          </Stat>
          <Stat label={t.permissions}>
            {fmt(t.permissionCount, { n: caps.length })}
            {runsCommands(caps) ? ` · ${t.canRunCommands}` : ''}
          </Stat>
          <Stat label={t.detailExpires}>
            {token.expiresAt ? localDate(token.expiresAt) : t.neverExpires}
          </Stat>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="font-medium text-fg text-ui-sm">{t.useInScript}</span>
          <CodeBlock lines={[`export ${ENV}=${masked(value)}`, EXAMPLE]} />
        </div>
        <p className="flex items-start gap-2 rounded-md border border-line px-3 py-2 text-fg-muted text-ui-sm">
          <InfoIcon className="mt-0.5 size-3.5 shrink-0" />
          {t.hashOnly}
        </p>
        <DialogFooter>
          <Button size="sm" onClick={onClose}>
            {t.done}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Stat({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="min-w-0 rounded-md border border-line px-3 py-2">
      <div className="text-fg-muted text-ui-xs">{label}</div>
      <div className="mt-0.5 text-fg text-ui-sm">{children}</div>
    </div>
  )
}

function TokenDetail({
  token,
  state,
  now,
  locale,
  onBack,
  onEdit,
  onRevoke,
}: {
  token: ScriptTokenInfo
  state: ScriptTokensState
  now: number
  locale: string
  onBack: () => void
  onEdit: () => void
  onRevoke: () => void
}): JSX.Element {
  const d = useDict()
  const t = d.scriptTokens
  const caps = shownCaps(token.caps)
  const created = fmt(token.source === 'settings' ? t.createdInSettings : t.createdFromCli, {
    date: localDate(token.createdAt),
  })
  const expiry = expiryState(token, now)
  return (
    <div>
      <button
        type="button"
        onClick={onBack}
        className="mb-3 inline-flex items-center gap-1 text-fg-muted text-ui-sm hover:text-fg"
      >
        <CaretLeftIcon className="size-3.5" />
        {t.back}
      </button>
      <div className="mb-4 flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-surface-2 text-fg-muted">
          <KeyIcon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate font-semibold text-fg text-ui-lg">{token.name}</h2>
            <ExpiryBadge token={token} now={now} />
          </div>
          <p className="text-fg-muted text-ui-sm">{created}</p>
        </div>
        <Button variant="outline" size="sm" onClick={onEdit}>
          {t.edit}
        </Button>
        <Button variant="destructive" size="sm" onClick={onRevoke}>
          {t.revoke}
        </Button>
      </div>
      <div className="mb-3 grid grid-cols-2 gap-2">
        <Stat label={t.detailExpires}>
          <div>{token.expiresAt ? localDate(token.expiresAt) : t.neverExpires}</div>
          {token.expiresAt && expiry !== 'expired' ? (
            <div className="text-fg-muted text-ui-xs">
              {fmt(t.daysLeft, { n: daysUntil(token.expiresAt, now) })}
            </div>
          ) : null}
          {expiry === 'expired' ? <div className="text-attn-fg text-ui-xs">{t.expired}</div> : null}
        </Stat>
        <Stat label={t.lastUsed}>
          <div>{lastUsedText(d, token.lastUsedAt, now, locale)}</div>
          {token.lastUsedAt ? (
            <div className="text-fg-muted text-ui-xs">{localTime(token.lastUsedAt)}</div>
          ) : null}
        </Stat>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-md border border-line px-3 py-2.5">
          <h3 className="mb-2 font-medium text-fg text-ui-sm">{t.access}</h3>
          {token.scope.kind === 'all' ? (
            <p className="text-fg text-ui-sm">{t.accessAll}</p>
          ) : (
            <ul className="flex flex-col gap-1 text-fg text-ui-sm">
              {token.scope.groups.map((id) => {
                const group = state.groups.find((g) => g.id === id)
                return (
                  <li key={`g:${id}`} className="flex items-center gap-1.5">
                    <GroupDot color={group?.color} />
                    {group ? fmt(t.groupChip, { name: group.name }) : t.deleted}
                    {group ? <span className="text-fg-dim">· {groupSize(id, state)}</span> : null}
                  </li>
                )
              })}
              {token.scope.workspaces.map((id) => {
                const ws = state.workspaces.find((w) => w.id === id)
                return (
                  <li key={`w:${id}`}>
                    {ws ? fmt(t.workspaceChip, { name: ws.name }) : t.deleted}
                  </li>
                )
              })}
              {token.scope.ownWorkspaces ? (
                <li className="flex items-center gap-1.5 text-fg-muted">
                  <PlusIcon className="size-3" />
                  {t.accessOwnShort}
                </li>
              ) : null}
            </ul>
          )}
        </div>
        <div className="rounded-md border border-line px-3 py-2.5">
          <h3 className="mb-2 font-medium text-fg text-ui-sm">{t.permissions}</h3>
          <ul className="flex flex-col gap-1 text-fg text-ui-sm">
            {caps.map((cap) => (
              <li key={cap} className="flex items-center justify-between gap-2">
                {t.caps[cap].label}
                {SCRIPT_TOKEN_RUN_CAPS.includes(cap) ? (
                  <span className="text-warn-fg text-ui-xs">{t.canRunCommands}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}

function latestRetired(state: ScriptTokensState): string {
  return state.retired.reduce((max, r) => (r.retiredAt > max ? r.retiredAt : max), '')
}

export function ScriptTokensSection(): JSX.Element {
  const d = useDict()
  const t = d.scriptTokens
  const locale = useSettingsStore((s) => s.locale)
  const [state, setState] = useState<ScriptTokensState>(EMPTY)
  const [now, setNow] = useState(() => Date.now())
  const [editing, setEditing] = useState<ScriptTokenInfo | null | undefined>(undefined)
  const [shown, setShown] = useState<Shown | null>(null)
  const [revoking, setRevoking] = useState<ScriptTokenInfo | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState(() => {
    const at = readPref(DISMISSED_KEY)
    return typeof at === 'string' ? at : ''
  })

  const reload = useCallback(() => {
    void window.ostia.scriptTokens.list().then((next) => {
      setState(next)
      setNow(Date.now())
    })
  }, [])
  useEffect(() => {
    reload()
    return window.ostia.scriptTokens.onChanged(reload)
  }, [reload])

  const tokens = useMemo(
    () => [...state.tokens].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [state.tokens],
  )
  const detail = detailId ? tokens.find((tk) => tk.id === detailId) : undefined
  const retiredAt = latestRetired(state)
  const showRetired = state.retired.length > 0 && retiredAt > dismissed

  const revoke = (token: ScriptTokenInfo): void => {
    setRevoking(null)
    void window.ostia.scriptTokens.revoke(token.id).then((ok) => {
      if (ok) {
        setStatus(fmt(t.revoked, { name: token.name }))
        if (detailId === token.id) setDetailId(null)
      }
      reload()
    })
  }

  const saved = (res: Extract<ScriptTokenSaveResult, { ok: true }>, regenerated: boolean): void => {
    const wasEditing = editing !== null && editing !== undefined
    setEditing(undefined)
    reload()
    if (res.value && regenerated) {
      setShown({
        title: fmt(wasEditing ? t.updatedTitle : t.createdTitle, { name: res.token.name }),
        value: res.value,
        token: res.token,
      })
      setStatus(null)
    } else {
      setStatus(t.renamed)
    }
  }

  return (
    <div>
      {detail ? (
        <TokenDetail
          token={detail}
          state={state}
          now={now}
          locale={locale}
          onBack={() => setDetailId(null)}
          onEdit={() => setEditing(detail)}
          onRevoke={() => setRevoking(detail)}
        />
      ) : (
        <>
          <div className="flex items-start justify-between gap-6">
            <div className="min-w-0">
              <SectionHead title={t.title} desc={fmt(t.desc, { env: ENV })} />
            </div>
            <Button size="sm" className="shrink-0" onClick={() => setEditing(null)}>
              <PlusIcon data-icon="inline-start" />
              {t.generate}
            </Button>
          </div>
          {showRetired ? (
            <RetiredBanner
              state={state}
              onDismiss={() => {
                writePref(DISMISSED_KEY, retiredAt)
                setDismissed(retiredAt)
              }}
            />
          ) : null}
          {tokens.length === 0 ? (
            <p className="rounded-md border border-line px-3 py-4 text-center text-fg-muted text-ui-sm">
              {t.empty}
            </p>
          ) : (
            <ul aria-label={t.title} className="rounded-md border border-line bg-surface-1">
              {tokens.map((token) => (
                <TokenRow
                  key={token.id}
                  token={token}
                  state={state}
                  now={now}
                  locale={locale}
                  onEdit={() => setEditing(token)}
                  onDetails={() => setDetailId(token.id)}
                  onRevoke={() => setRevoking(token)}
                />
              ))}
            </ul>
          )}
          {status ? (
            <output className="mt-2 block text-fg-muted text-ui-sm">{status}</output>
          ) : null}
          <div className="mt-6">
            <SettingsGroup title={t.outsideTitle} desc={t.outsideDesc}>
              <CodeBlock lines={[`export ${ENV}=ostia_…`, EXAMPLE]} />
            </SettingsGroup>
          </div>
        </>
      )}
      {editing !== undefined ? (
        <TokenDialog
          key={editing?.id ?? 'new'}
          token={editing}
          state={state}
          onClose={() => setEditing(undefined)}
          onSaved={saved}
        />
      ) : null}
      {shown ? <ShownDialog shown={shown} state={state} onClose={() => setShown(null)} /> : null}
      <AlertDialog open={revoking !== null} onOpenChange={(open) => !open && setRevoking(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {fmt(t.revokeTitle, { name: revoking?.name ?? '' })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t.revokeBody}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="sm">{t.cancel}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              size="sm"
              onClick={() => revoking && revoke(revoking)}
            >
              {t.revoke}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
