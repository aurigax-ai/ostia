import { type PackageSettings, type WorkspacePackages, checkPackageKey } from '@shared/sandbox'
import { useDict } from '../i18n/useDict'
import { type ListEditResult, SandboxListEditor } from './SandboxListEditor'
import { ControlRow } from './SettingsPanel'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Switch } from './ui/switch'

function packageErrors(next: string[]): ListEditResult {
  const bad = next.filter((value) => !checkPackageKey(value))
  return bad.length > 0
    ? { ok: false, errors: bad.map((value) => ({ value, reason: 'package-key' })) }
    : { ok: true }
}

function Status({
  overridden,
  onReset,
}: {
  overridden: boolean | undefined
  onReset?: () => void
}): JSX.Element | null {
  const d = useDict()
  if (overridden === undefined) return null
  return (
    <>
      <Badge variant="outline">{overridden ? d.sandbox.overridden : d.sandbox.inherited}</Badge>
      {overridden && onReset ? (
        <Button variant="ghost" size="xs" onClick={onReset}>
          {d.sandbox.reset}
        </Button>
      ) : null}
    </>
  )
}

export function PackagesEditor({
  effective,
  own,
  inheritedDeny = [],
  onChange,
}: {
  effective: PackageSettings
  own?: WorkspacePackages
  inheritedDeny?: readonly string[]
  onChange: (next: WorkspacePackages) => Promise<void>
}): JSX.Element {
  const d = useDict()
  const scoped = own !== undefined
  const current = own ?? {}
  const without = (key: keyof WorkspacePackages): WorkspacePackages => {
    const { [key]: _gone, allowances: _a, ...rest } = current
    return rest
  }
  const settings = (next: WorkspacePackages): WorkspacePackages => {
    const { allowances: _a, ...rest } = next
    return rest
  }
  return (
    <>
      <fieldset aria-label={d.sandbox.malware}>
        <ControlRow label={d.sandbox.malware} desc={d.sandbox.malwareDesc}>
          <Status
            overridden={scoped ? current.malware !== undefined : undefined}
            onReset={() => void onChange(without('malware'))}
          />
          <Switch
            aria-label={d.sandbox.malware}
            checked={effective.malware}
            onCheckedChange={(malware) => void onChange({ ...settings(current), malware })}
          />
        </ControlRow>
      </fieldset>
      <fieldset aria-label={d.sandbox.cooldown}>
        <ControlRow label={d.sandbox.cooldown} desc={d.sandbox.cooldownDesc}>
          <Status
            overridden={scoped ? current.cooldownDays !== undefined : undefined}
            onReset={() => void onChange(without('cooldownDays'))}
          />
          <Input
            type="number"
            min={0}
            max={60}
            aria-label={d.sandbox.cooldown}
            value={effective.cooldownDays}
            onChange={(e) => {
              const days = Number(e.target.value)
              if (Number.isInteger(days) && days >= 0 && days <= 60) {
                void onChange({ ...settings(current), cooldownDays: days })
              }
            }}
            className="h-7 w-20"
          />
        </ControlRow>
      </fieldset>
      <SandboxListEditor
        label={d.sandbox.denyList}
        desc={d.sandbox.denyListDesc}
        items={scoped ? (current.denyList ?? []) : effective.denyList}
        inherited={scoped ? inheritedDeny : []}
        placeholder="npm:left-pad"
        onChange={async (denyList) => {
          const checked = packageErrors(denyList)
          if (checked.ok) await onChange({ ...settings(current), denyList })
          return checked
        }}
      />
      <fieldset aria-label={d.sandbox.allowOnly}>
        <ControlRow label={d.sandbox.allowOnly} desc={d.sandbox.allowOnlyDesc}>
          <Status
            overridden={scoped ? current.allowOnly !== undefined : undefined}
            onReset={() => void onChange(without('allowOnly'))}
          />
          <Switch
            aria-label={d.sandbox.allowOnly}
            checked={effective.allowOnly !== null}
            onCheckedChange={(on) =>
              void onChange({
                ...settings(current),
                allowOnly: on ? (effective.allowOnly ?? []) : null,
              })
            }
          />
        </ControlRow>
      </fieldset>
      {effective.allowOnly !== null ? (
        <SandboxListEditor
          label={d.sandbox.allowOnlyList}
          items={effective.allowOnly}
          placeholder="npm:react"
          onChange={async (allowOnly) => {
            const checked = packageErrors(allowOnly)
            if (checked.ok) await onChange({ ...settings(current), allowOnly })
            return checked
          }}
        />
      ) : null}
    </>
  )
}
