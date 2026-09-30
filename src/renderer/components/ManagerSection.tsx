import { XIcon } from '@phosphor-icons/react'
import { splitArgs } from '@shared/argv'
import {
  BUILTIN_MANAGER_AGENTS,
  MANAGER_AGENT_NAME,
  MANAGER_FEATURE,
  MANAGER_LIMIT_BOUNDS,
  type ManagerLimits,
  isManagerArgv,
  isSkillPath,
} from '@shared/managerSettings'
import { quoteArgv } from '@shared/shellQuote'
import type { RequirementsReport } from '@shared/systemRequirements'
import { useEffect, useState } from 'react'
import { fmt, useDict } from '../i18n/useDict'
import { useSettingsStore } from '../stores/settingsStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { IconButton } from './IconButton'
import { NumberRow, SectionHead, SettingsGroup, ToggleRow, WarningNote } from './SettingsPanel'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Input } from './ui/input'

function parseCommand(line: string): string[] | null {
  const argv = splitArgs(line)
  return argv && isManagerArgv(argv) ? argv : null
}

function PresetRow({
  name,
  argv,
  builtin,
}: {
  name: string
  argv: string[]
  builtin: boolean
}): JSX.Element {
  const d = useDict()
  const agents = useSettingsStore((s) => s.manager.agents)
  const setManager = useSettingsStore((s) => s.setManager)
  const [draft, setDraft] = useState(quoteArgv(argv))
  const [invalid, setInvalid] = useState(false)
  useEffect(() => setDraft(quoteArgv(argv)), [argv])
  const commit = (): void => {
    const next = parseCommand(draft)
    setInvalid(next === null)
    if (next && quoteArgv(next) !== quoteArgv(argv)) {
      setManager({ agents: { ...agents, [name]: next } })
    }
  }
  const { [name]: _removed, ...rest } = agents
  return (
    <li className="py-1.5">
      <div className="flex items-center gap-3">
        <span className="w-28 shrink-0 truncate font-mono text-fg text-ui-base">{name}</span>
        <Input
          value={draft}
          spellCheck={false}
          aria-label={fmt(d.manager.commandFor, { name })}
          aria-invalid={invalid}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
          }}
          className="h-7 flex-1 font-mono"
        />
        {builtin ? (
          <Badge variant="outline" className="text-ui-xs">
            {d.manager.builtin}
          </Badge>
        ) : (
          <IconButton
            icon={XIcon}
            label={fmt(d.manager.removePreset, { name })}
            onClick={() => setManager({ agents: rest })}
          />
        )}
      </div>
      {invalid ? <WarningNote>{d.manager.badCommand}</WarningNote> : null}
    </li>
  )
}

function AddPreset(): JSX.Element {
  const d = useDict()
  const agents = useSettingsStore((s) => s.manager.agents)
  const setManager = useSettingsStore((s) => s.setManager)
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [error, setError] = useState<string | null>(null)
  const add = (): void => {
    const trimmed = name.trim()
    if (!MANAGER_AGENT_NAME.test(trimmed)) {
      setError(d.manager.badName)
      return
    }
    const argv = parseCommand(command)
    if (!argv) {
      setError(d.manager.badCommand)
      return
    }
    setManager({ agents: { ...agents, [trimmed]: argv } })
    setName('')
    setCommand('')
    setError(null)
  }
  return (
    <div className="pt-2">
      <div className="flex items-center gap-3">
        <Input
          value={name}
          spellCheck={false}
          placeholder={d.manager.presetName}
          aria-label={d.manager.presetName}
          onChange={(e) => setName(e.target.value)}
          className="h-7 w-28 shrink-0 font-mono"
        />
        <Input
          value={command}
          spellCheck={false}
          placeholder={d.manager.presetCommand}
          aria-label={d.manager.presetCommand}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add()
          }}
          className="h-7 flex-1 font-mono"
        />
        <Button variant="outline" size="sm" onClick={add}>
          {d.manager.addPreset}
        </Button>
      </div>
      {error ? <WarningNote>{error}</WarningNote> : null}
    </div>
  )
}

function SkillsGroup(): JSX.Element {
  const d = useDict()
  const skills = useSettingsStore((s) => s.manager.skills)
  const setManager = useSettingsStore((s) => s.setManager)
  const [draft, setDraft] = useState('')
  const [invalid, setInvalid] = useState(false)
  const add = (): void => {
    const path = draft.trim().replace(/\/+$/, '')
    if (!isSkillPath(path)) {
      setInvalid(true)
      return
    }
    setManager({ skills: [...skills, path] })
    setDraft('')
    setInvalid(false)
  }
  return (
    <SettingsGroup title={d.manager.groupSkills}>
      <p className="mb-2 text-fg-muted text-ui-sm">{d.manager.skillsDesc}</p>
      {skills.length === 0 ? (
        <p className="py-1.5 text-fg-muted text-ui-sm">{d.manager.noSkills}</p>
      ) : (
        <ul className="flex flex-col">
          {skills.map((path) => (
            <li key={path} className="flex items-center gap-3 py-1">
              <span className="min-w-0 flex-1 truncate font-mono text-fg text-ui-sm">{path}</span>
              <IconButton
                icon={XIcon}
                label={fmt(d.manager.removeSkill, { path })}
                onClick={() => setManager({ skills: skills.filter((s) => s !== path) })}
              />
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-3 pt-2">
        <Input
          value={draft}
          spellCheck={false}
          placeholder={d.manager.skillPath}
          aria-label={d.manager.skillPath}
          aria-invalid={invalid}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add()
          }}
          className="h-7 flex-1 font-mono"
        />
        <Button variant="outline" size="sm" onClick={add}>
          {d.manager.addSkill}
        </Button>
      </div>
      {invalid ? <WarningNote>{d.manager.badSkill}</WarningNote> : null}
    </SettingsGroup>
  )
}

function RequirementsNote(): JSX.Element | null {
  const d = useDict()
  const workspaceId = useWorkspacesStore((s) => s.activeWorkspaceId)
  const [report, setReport] = useState<RequirementsReport | null>(null)
  useEffect(() => {
    let live = true
    void window.pine.system.requirements(MANAGER_FEATURE).then((next) => {
      if (live) setReport(next)
    })
    return () => {
      live = false
    }
  }, [])
  if (!report || report.missing.length === 0) return null
  const command = report.hint.command
  return (
    <WarningNote>
      <p>{fmt(d.manager.requirementsBody, { packages: report.hint.packages.join(', ') })}</p>
      {report.canInstall && workspaceId ? (
        <Button
          size="sm"
          className="mt-2"
          onClick={() => void window.pine.system.installRequirements(MANAGER_FEATURE, workspaceId)}
        >
          {d.manager.install}
        </Button>
      ) : command ? (
        <div className="mt-2 flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate font-mono text-ui-sm">{command}</code>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void navigator.clipboard?.writeText(command)}
          >
            {d.manager.copyCommand}
          </Button>
        </div>
      ) : null}
    </WarningNote>
  )
}

const LIMIT_KEYS: (keyof ManagerLimits)[] = ['maxWorkers', 'spawnsPer10Min', 'busPerMinute']

export function ManagerSection(): JSX.Element {
  const d = useDict()
  const manager = useSettingsStore((s) => s.manager)
  const setManager = useSettingsStore((s) => s.setManager)
  const presets = [
    ...Object.entries(BUILTIN_MANAGER_AGENTS)
      .filter(([name]) => !(name in manager.agents))
      .map(([name, argv]) => ({ name, argv: [...argv], builtin: true })),
    ...Object.entries(manager.agents).map(([name, argv]) => ({
      name,
      argv,
      builtin: false,
    })),
  ]
  const limitLabel: Record<keyof ManagerLimits, [string, string]> = {
    maxWorkers: [d.manager.maxWorkers, d.manager.maxWorkersDesc],
    spawnsPer10Min: [d.manager.spawnsPer10Min, d.manager.spawnsPer10MinDesc],
    busPerMinute: [d.manager.busPerMinute, d.manager.busPerMinuteDesc],
  }
  return (
    <div>
      <SectionHead title={d.manager.settingsTitle} desc={d.manager.settingsDesc} />
      <RequirementsNote />
      <SettingsGroup title={d.manager.groupAgents}>
        <p className="mb-2 text-fg-muted text-ui-sm">{d.manager.agentsDesc}</p>
        <ul className="flex flex-col">
          {presets.map((p) => (
            <PresetRow key={p.name} name={p.name} argv={p.argv} builtin={p.builtin} />
          ))}
        </ul>
        <AddPreset />
      </SettingsGroup>
      <SkillsGroup />
      <SettingsGroup title={d.manager.groupPermissions}>
        <ToggleRow
          label={d.manager.allowInput}
          desc={d.manager.allowInputDesc}
          checked={manager.allowInput}
          onChange={(v) => setManager({ allowInput: v })}
        />
      </SettingsGroup>
      <SettingsGroup title={d.manager.groupLimits}>
        {LIMIT_KEYS.map((key) => {
          const [label, desc] = limitLabel[key]
          const [min, max] = MANAGER_LIMIT_BOUNDS[key]
          return (
            <NumberRow
              key={key}
              label={label}
              desc={desc}
              value={manager.limits[key]}
              min={min}
              max={max}
              onCommit={(n) => setManager({ limits: { ...manager.limits, [key]: n } })}
            />
          )
        })}
      </SettingsGroup>
    </div>
  )
}
