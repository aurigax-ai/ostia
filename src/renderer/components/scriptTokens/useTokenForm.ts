import type { Capability } from '@aurigax-ai/ostia-extension-sdk/contract/capabilities'
import type { Dict } from '@shared/app/dict'
import {
  DEFAULT_TOKEN_EXPIRY,
  NEVER_EXPIRES,
  SCRIPT_TOKEN_PRESETS,
  SCRIPT_TOKEN_UI_CAPS,
  type ScriptTokenInfo,
  type ScriptTokenSaveResult,
  type ScriptTokenScope,
  type ScriptTokensState,
  type ScriptTokenUpdateInput,
} from '@shared/permissions/scriptTokens'
import { useState } from 'react'
import { fmt, useDict } from '@/lib/app/useDict'
import {
  knownScope,
  presetOf,
  reachedCount,
  reachText,
  sameScope,
  sameSet,
  shownCaps,
} from './tokenScope'
import { expiryState, failureText, localDate } from './tokenText'

export const NAME_PATTERN = /^[\w .@-]{1,60}$/

type ExpiryChoice = '7d' | '30d' | '90d' | '1y' | 'custom' | 'never' | 'keep'

export interface TokenForm {
  now: number
  name: string
  setName: (name: string) => void
  caps: Capability[]
  setCaps: (caps: Capability[]) => void
  kind: ScriptTokenScope['kind']
  setKind: (kind: ScriptTokenScope['kind']) => void
  groups: string[]
  setGroups: (groups: string[]) => void
  workspaces: string[]
  setWorkspaces: (workspaces: string[]) => void
  own: boolean
  setOwn: (own: boolean) => void
  expiry: ExpiryChoice
  setExpiry: (expiry: ExpiryChoice) => void
  customDate: string
  setCustomDate: (date: string) => void
  askNever: boolean
  setAskNever: (ask: boolean) => void
  busy: boolean
  error: string | null
  trimmed: string
  scopeEmpty: boolean
  valid: boolean
  changed: boolean
  regenerates: boolean
  reach: string
  preset: ReturnType<typeof presetOf>
  expiryOptions: { value: ExpiryChoice; label: string }[]
  send: (choice: ExpiryChoice) => Promise<void>
  submit: () => void
  toggleCap: (cap: Capability, on: boolean) => void
}

function expiryOptionsOf(
  t: Dict['scriptTokens'],
  token: ScriptTokenInfo | null,
  now: number,
): { value: ExpiryChoice; label: string }[] {
  return [
    ...(token && expiryState(token, now) !== 'expired'
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
}

export function useTokenForm({
  token,
  state,
  onSaved,
}: {
  token: ScriptTokenInfo | null
  state: ScriptTokensState
  onSaved: (res: Extract<ScriptTokenSaveResult, { ok: true }>, regenerated: boolean) => void
}): TokenForm {
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

  const expiryOptions = expiryOptionsOf(t, token, now)

  const neverAfter = (choice: ExpiryChoice): boolean =>
    choice === NEVER_EXPIRES || (choice === 'keep' && token?.expiresAt === null)

  const send = async (choice: ExpiryChoice): Promise<void> => {
    setBusy(true)
    setError(null)
    const expires = choice === 'custom' ? customDate : choice
    const never = neverAfter(choice) ? { confirmNeverExpires: true } : {}
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
      if (choice !== 'keep') input.expires = expires
      if (regenerates) Object.assign(input, never)
      res = await window.ostia.scriptTokens.update(input)
    }
    setBusy(false)
    if (res.ok) onSaved(res, regenerates)
    else setError(failureText(d, res))
  }

  const submit = (): void => {
    if (!valid || !changed || busy) return
    if (regenerates && neverAfter(expiry)) {
      setAskNever(true)
      return
    }
    void send(expiry)
  }

  const toggleCap = (cap: Capability, on: boolean): void =>
    setCaps((list) => SCRIPT_TOKEN_UI_CAPS.filter((c) => (c === cap ? on : list.includes(c))))

  return {
    now,
    name,
    setName,
    caps,
    setCaps,
    kind,
    setKind,
    groups,
    setGroups,
    workspaces,
    setWorkspaces,
    own,
    setOwn,
    expiry,
    setExpiry,
    customDate,
    setCustomDate,
    askNever,
    setAskNever,
    busy,
    error,
    trimmed,
    scopeEmpty,
    valid,
    changed,
    regenerates,
    reach,
    preset,
    expiryOptions,
    send,
    submit,
    toggleCap,
  }
}
