import { matchingBranches, toggledRefs } from '@/lib/git/gitView'
import { CaretDownIcon, GitBranchIcon, MagnifyingGlassIcon } from '@phosphor-icons/react'
import type { Dict } from '@shared/app/dict'
import type { BranchRef, GitGraphData, GraphScope } from '@shared/boards/git'
import { useId, useState } from 'react'
import { fmt, useDict } from '../../i18n/useDict'
import { Checkbox } from '../ui/checkbox'
import { InputGroup, InputGroupAddon, InputGroupInput } from '../ui/input-group'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { RadioGroup, RadioGroupItem } from '../ui/radio-group'

type ScopeKind = GraphScope['kind']

const OPTION_CLASS =
  'flex min-h-7 items-center gap-2 rounded-sm px-2 text-ui-sm hover:bg-surface-3 has-data-disabled:opacity-50'
const GROUP_TITLE_CLASS =
  'px-2 pt-2 pb-0.5 font-medium text-fg-muted text-ui-xs uppercase tracking-caps'
const HINT_CLASS = 'ml-auto whitespace-nowrap text-fg-muted text-ui-xs'

export function scopeLabel(t: Dict['git'], data: GitGraphData): string {
  const scope = data.scope
  if (scope.kind === 'current') return t.scopeCurrent
  if (scope.kind === 'all') return t.scopeAll
  if (scope.refs.length !== 1) return fmt(t.scopeBranches, { count: scope.refs.length })
  return data.branches.find((b) => b.ref === scope.refs[0])?.name ?? scope.refs[0]
}

function BranchGroup({
  label,
  branches,
  chosen,
  onScope,
}: {
  label: string
  branches: BranchRef[]
  chosen: string[]
  onScope: (scope: GraphScope) => void
}): JSX.Element | null {
  const t = useDict().git
  const ids = useId()
  if (branches.length === 0) return null
  return (
    <fieldset className="branch-group m-0 min-w-0 border-0 p-0">
      <legend className={GROUP_TITLE_CLASS}>{label}</legend>
      {branches.map((b) => {
        const on = chosen.includes(b.ref)
        const last = on && chosen.length === 1
        const id = `${ids}-${b.ref}`
        return (
          <label
            key={b.ref}
            htmlFor={id}
            className={`branch-choice ${OPTION_CLASS}`}
            title={last ? t.lastChosen : b.ref}
          >
            <Checkbox
              id={id}
              data-branch={b.ref}
              checked={on}
              disabled={last}
              onCheckedChange={() => onScope({ kind: 'chosen', refs: toggledRefs(chosen, b.ref) })}
            />
            <span className="min-w-0 truncate font-mono">{b.name}</span>
            {b.current ? <span className={HINT_CLASS}>{t.head}</span> : null}
          </label>
        )
      })}
    </fieldset>
  )
}

function BranchPicker({
  data,
  chosen,
  onScope,
}: { data: GitGraphData; chosen: string[]; onScope: (scope: GraphScope) => void }): JSX.Element {
  const t = useDict().git
  const [query, setQuery] = useState('')
  const matches = matchingBranches(data.branches, query)
  return (
    <div className="branch-picker mt-1 flex min-h-0 flex-col border-line border-t pt-2">
      <InputGroup className="mx-1 mb-1 h-7 w-auto">
        <InputGroupAddon>
          <MagnifyingGlassIcon />
        </InputGroupAddon>
        <InputGroupInput
          type="search"
          className="branch-search text-ui-sm md:text-ui-sm"
          aria-label={t.filterBranches}
          placeholder={t.filterBranches}
          spellCheck={false}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </InputGroup>
      <div className="branch-list min-h-0 overflow-auto">
        {matches.length === 0 ? (
          <div className="branch-empty px-2 py-3 text-fg-muted text-ui-sm">{t.noMatch}</div>
        ) : (
          <>
            <BranchGroup
              label={t.local}
              branches={matches.filter((b) => !b.remote)}
              chosen={chosen}
              onScope={onScope}
            />
            <BranchGroup
              label={t.remote}
              branches={matches.filter((b) => b.remote)}
              chosen={chosen}
              onScope={onScope}
            />
          </>
        )}
      </div>
    </div>
  )
}

export function ScopeControl({
  data,
  onScope,
}: { data: GitGraphData; onScope: (scope: GraphScope) => void }): JSX.Element {
  const t = useDict().git
  const ids = useId()
  const current = data.branches.find((b) => b.current)
  const options: { kind: ScopeKind; label: string; hint: string | null; disabled: boolean }[] = [
    { kind: 'current', label: t.scopeCurrent, hint: current?.name ?? null, disabled: false },
    { kind: 'all', label: t.scopeAll, hint: t.scopeAllHint, disabled: false },
    {
      kind: 'chosen',
      label: t.scopeChosen,
      hint: data.branches.length === 0 ? t.noBranches : null,
      disabled: data.branches.length === 0,
    },
  ]
  const choose = (kind: ScopeKind): void => {
    if (kind !== 'chosen') {
      onScope({ kind })
      return
    }
    const ref = current?.ref ?? data.branches[0]?.ref
    if (ref) onScope({ kind: 'chosen', refs: [ref] })
  }
  return (
    <Popover>
      <PopoverTrigger render={<button type="button" className="scope-trigger" title={t.scope} />}>
        <GitBranchIcon />
        <span className="scope-trigger-label">{scopeLabel(t, data)}</span>
        <CaretDownIcon />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label={t.scope}
        className="scope-menu max-h-[min(420px,70vh)] w-[min(300px,calc(100vw-16px))] gap-0 p-1 text-fg text-ui-sm"
      >
        <RadioGroup
          aria-label={t.scope}
          value={data.scope.kind}
          onValueChange={(value) => choose(value as ScopeKind)}
          className="scope-kinds flex flex-col gap-0"
        >
          {options.map((o) => (
            <label
              key={o.kind}
              htmlFor={`${ids}-${o.kind}`}
              className={`scope-option ${OPTION_CLASS}`}
            >
              <RadioGroupItem
                id={`${ids}-${o.kind}`}
                value={o.kind}
                data-scope={o.kind}
                disabled={o.disabled}
              />
              <span className="font-medium">{o.label}</span>
              {o.hint ? <span className={HINT_CLASS}>{o.hint}</span> : null}
            </label>
          ))}
        </RadioGroup>
        {data.scope.kind === 'chosen' ? (
          <BranchPicker data={data} chosen={data.scope.refs} onScope={onScope} />
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
