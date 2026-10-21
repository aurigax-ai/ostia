import { WarningIcon } from '@phosphor-icons/react'
import {
  SCRIPT_TOKEN_PRESETS,
  SCRIPT_TOKEN_RUN_CAPS,
  type ScriptTokenInfo,
  type ScriptTokenSaveResult,
  type ScriptTokenScope,
  type ScriptTokensState,
  type ScriptTokenUiCap,
} from '@shared/permissions/scriptTokens'
import { SelectField } from '@/components/settingsKit/SelectField'
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
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
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
import { fmt, useDict } from '@/lib/app/useDict'
import { cn } from '@/lib/utils'
import { ScopePicker } from './ScopePicker'
import { DAY_MS, localDate, sentence } from './tokenText'
import { NAME_PATTERN, type TokenForm, useTokenForm } from './useTokenForm'

export function TokenDialog({
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
  const editing = token !== null
  const form = useTokenForm({ token, state, onSaved })
  const {
    trimmed,
    expiry,
    setExpiry,
    askNever,
    setAskNever,
    busy,
    error,
    valid,
    changed,
    regenerates,
    reach,
    send,
    submit,
  } = form

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
          <NameExpiryFields form={form} />

          <AccessFieldset form={form} state={state} />

          <PermissionsFieldset form={form} />
          {editing && changed ? (
            <p
              className={cn(
                'flex items-start gap-2 text-ui-sm',
                regenerates ? 'text-warn-fg' : 'text-fg-muted',
              )}
            >
              {regenerates ? <WarningIcon className="mt-0.5 size-4 shrink-0" /> : null}
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
                  void send(expiry)
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

function NameExpiryFields({ form }: { form: TokenForm }): JSX.Element {
  const t = useDict().scriptTokens
  const {
    name,
    setName,
    trimmed,
    expiry,
    setExpiry,
    expiryOptions,
    customDate,
    setCustomDate,
    now,
  } = form
  return (
    <>
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
            placeholder="deploy-bot"
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
          <WarningIcon className="mt-0.5 size-4 shrink-0" />
          {t.neverWarn}
        </p>
      ) : null}
    </>
  )
}

function AccessFieldset({
  form,
  state,
}: {
  form: TokenForm
  state: ScriptTokensState
}): JSX.Element {
  const t = useDict().scriptTokens
  const { kind, setKind, groups, setGroups, workspaces, setWorkspaces, own, setOwn, scopeEmpty } =
    form
  return (
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
  )
}

const PERMISSION_COLUMNS: { id: 'read' | 'change' | 'control'; caps: ScriptTokenUiCap[] }[][] = [
  [
    { id: 'read', caps: ['read-board', 'read-other-pane'] },
    { id: 'change', caps: ['notify', 'send-other-pane', 'kill-pane'] },
  ],
  [{ id: 'control', caps: ['type-other-pane', 'process'] }],
]

function PermissionsFieldset({ form }: { form: TokenForm }): JSX.Element {
  const t = useDict().scriptTokens
  const { caps, setCaps, preset, toggleCap } = form
  return (
    <fieldset aria-label={t.permissions} className="flex flex-col gap-3">
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
      <div className="grid grid-cols-2 gap-x-8">
        {PERMISSION_COLUMNS.map((column) => (
          <div key={column[0].id} className="flex flex-col gap-3">
            {column.map((group) => (
              <fieldset key={group.id} className="min-w-0">
                <legend className="mb-1 font-medium text-fg-muted text-ui-xs">
                  {t.permissionGroups[group.id]}
                </legend>
                {group.caps.map((cap) => (
                  <Label
                    key={cap}
                    className="flex cursor-pointer items-start gap-2.5 py-1.5 font-normal"
                  >
                    <Checkbox
                      className="mt-0.5"
                      checked={caps.includes(cap)}
                      onCheckedChange={(checked) => toggleCap(cap, checked === true)}
                    />
                    <span className="min-w-0">
                      <span className="flex flex-wrap items-center gap-x-2 text-fg text-ui-base">
                        {t.capNames[cap]}
                        {SCRIPT_TOKEN_RUN_CAPS.includes(cap) ? (
                          <span className="inline-flex items-center gap-1 text-ui-xs text-warn-fg">
                            <WarningIcon className="size-4" aria-hidden />
                            {t.runsCommands}
                          </span>
                        ) : null}
                      </span>
                      <span className="block text-fg-muted text-ui-sm">{t.caps[cap].desc}</span>
                    </span>
                  </Label>
                ))}
              </fieldset>
            ))}
          </div>
        ))}
      </div>
      {caps.length === 0 ? <p className="text-fg-muted text-ui-sm">{t.permissionsNone}</p> : null}
    </fieldset>
  )
}
