import { XIcon } from '@phosphor-icons/react'
import {
  BUILTIN_MANAGER_AGENTS,
  isManagerArgv,
  isSkillPath,
  MANAGER_AGENT_NAME,
  MANAGER_FEATURE,
  MANAGER_LIMIT_BOUNDS,
  type ManagerLimits,
} from '@shared/agents/managerSettings'
import { splitArgs } from '@shared/terminal/argv'
import { quoteArgv } from '@shared/terminal/shellQuote'
import { type JSX, useState } from 'react'
import { IconButton } from '@/components/common/IconButton'
import { Notice } from '@/components/common/Notice'
import { CommitInput } from '@/components/settingsKit/CommitInput'
import { NumberRow, ToggleRow } from '@/components/settingsKit/ControlRow'
import { SettingsGroup } from '@/components/settingsKit/SettingsGroup'
import { SettingsList } from '@/components/settingsKit/SettingsList'
import { SettingsListRow } from '@/components/settingsKit/SettingsListRow'
import { SettingsPage } from '@/components/settingsKit/SettingsPage'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { fmt, useDict } from '@/lib/app/useDict'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { RequirementsNote } from './RequirementsNote'

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
  const [invalid, setInvalid] = useState(false)
  const commit = (text: string): boolean => {
    const next = parseCommand(text)
    setInvalid(next === null)
    if (next) setManager({ agents: { ...agents, [name]: next } })
    return next !== null
  }
  const { [name]: _removed, ...rest } = agents
  return (
    <li className="py-1.5">
      <div className="flex items-center gap-3">
        <span className="w-28 shrink-0 truncate font-mono text-fg text-ui-base">{name}</span>
        <CommitInput
          value={quoteArgv(argv)}
          spellCheck={false}
          aria-label={fmt(d.manager.commandFor, { name })}
          aria-invalid={invalid}
          onCommit={commit}
          onCancel={() => setInvalid(false)}
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
      {invalid ? <Notice>{d.manager.badCommand}</Notice> : null}
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
      {error ? <Notice>{error}</Notice> : null}
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
      <SettingsList
        label={d.manager.groupSkills}
        empty={d.manager.noSkills}
        add={
          <div className="flex items-center gap-3">
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
        }
      >
        {skills.map((path) => (
          <SettingsListRow
            key={path}
            title={<span className="font-mono text-ui-sm">{path}</span>}
            actions={
              <IconButton
                icon={XIcon}
                label={fmt(d.manager.removeSkill, { path })}
                onClick={() => setManager({ skills: skills.filter((s) => s !== path) })}
              />
            }
          />
        ))}
      </SettingsList>
      {invalid ? <Notice>{d.manager.badSkill}</Notice> : null}
    </SettingsGroup>
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
    <SettingsPage title={d.manager.settingsTitle} desc={d.manager.settingsDesc}>
      <RequirementsNote feature={MANAGER_FEATURE} body={d.manager.requirementsBody} />
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
    </SettingsPage>
  )
}
