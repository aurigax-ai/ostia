import {
  type NameProblem,
  OWN_PLAYBOOKS_MAX,
  playbookDescriptionProblem,
  playbookNameProblem,
  playbookTextProblem,
  type ResolvedPlaybook,
} from '@shared/agents/playbooks'
import { type JSX, useState } from 'react'
import { MachineValue } from '@/components/common/MachineValue'
import { Notice } from '@/components/common/Notice'
import { TextLink } from '@/components/common/TextLink'
import { CommitInput } from '@/components/settingsKit/CommitInput'
import { ControlRow } from '@/components/settingsKit/ControlRow'
import { SettingsGroup } from '@/components/settingsKit/SettingsGroup'
import { Button } from '@/components/ui/button'
import { useDict } from '@/lib/app/useDict'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { PlaybookPrompt } from './PlaybookPrompt'

export interface Draft {
  name: string
  description: string
  text: string
}

export const EMPTY_DRAFT: Draft = { name: '', description: '', text: '' }

const bareName = (value: string): string => value.trim().replace(/^\//, '')

function useTokens(text: string): string {
  const d = useDict()
  return d.playbooks.tokens.replace('{count}', String(Math.ceil(text.length / 4)))
}

function useNameError(
  extensionIds: readonly string[],
): (name: string, taken: readonly string[]) => string | null {
  const d = useDict()
  return (name, taken) => {
    const problem: NameProblem | null = playbookNameProblem(name, taken, extensionIds)
    return problem ? d.playbooks.nameProblems[problem].replace('{name}', name) : null
  }
}

function Pending({ playbook }: { playbook: ResolvedPlaybook }): JSX.Element {
  const d = useDict()
  const accept = useSettingsStore((s) => s.acceptPlaybook)
  const [shown, setShown] = useState(false)
  return (
    <>
      <Notice
        tone="info"
        actions={
          <>
            {playbook.builtin ? (
              <TextLink size="xs" onClick={() => setShown((v) => !v)}>
                {shown ? d.playbooks.hideDefault : d.playbooks.showDefault}
              </TextLink>
            ) : null}
            <TextLink size="xs" onClick={() => accept(playbook.id)}>
              {d.playbooks.useIt}
            </TextLink>
          </>
        }
      >
        {d.playbooks.changedElsewhere}
      </Notice>
      {shown ? (
        <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-surface-2 p-3 font-mono text-fg text-ui-sm">
          {playbook.unaccepted}
        </pre>
      ) : null}
    </>
  )
}

function DefaultChanged({ playbook }: { playbook: ResolvedPlaybook }): JSX.Element {
  const d = useDict()
  const resetPlaybook = useSettingsStore((s) => s.resetPlaybook)
  const [shown, setShown] = useState(false)
  return (
    <>
      <Notice
        tone="info"
        actions={
          <>
            <TextLink size="xs" onClick={() => setShown((v) => !v)}>
              {shown ? d.playbooks.hideDefault : d.playbooks.showDefault}
            </TextLink>
            <TextLink size="xs" onClick={() => resetPlaybook(playbook.id)}>
              {d.playbooks.reset}
            </TextLink>
          </>
        }
      >
        {d.playbooks.defaultChanged}
      </Notice>
      {shown ? (
        <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-surface-2 p-3 font-mono text-fg text-ui-sm">
          {playbook.defaultText}
        </pre>
      ) : null}
    </>
  )
}

export function PlaybookDetail({
  playbook,
  ownNames,
  extensionIds,
  onRenamed,
}: {
  playbook: ResolvedPlaybook
  ownNames: readonly string[]
  extensionIds: readonly string[]
  onRenamed: (name: string) => void
}): JSX.Element {
  const d = useDict()
  const setText = useSettingsStore((s) => s.setPlaybookText)
  const resetPlaybook = useSettingsStore((s) => s.resetPlaybook)
  const save = useSettingsStore((s) => s.saveOwnPlaybook)
  const remove = useSettingsStore((s) => s.deleteOwnPlaybook)
  const nameError = useNameError(extensionIds)
  const [commandError, setCommandError] = useState<string | null>(null)
  const [descriptionError, setDescriptionError] = useState<string | null>(null)
  const fields = { description: playbook.description, text: playbook.text }
  const command = `/${playbook.id}`
  const action = (
    <>
      <MachineValue value={useTokens(playbook.text)} />
      {playbook.edited && !playbook.defaultChanged ? (
        <TextLink size="xs" onClick={() => resetPlaybook(playbook.id)}>
          {d.playbooks.resetDefault}
        </TextLink>
      ) : null}
      {playbook.builtin ? null : (
        <Button variant="outline" size="xs" onClick={() => remove(playbook.id)}>
          {d.playbooks.delete}
        </Button>
      )}
    </>
  )
  return (
    <SettingsGroup title={command} action={action}>
      {playbook.unaccepted !== null ? <Pending playbook={playbook} /> : null}
      {playbook.defaultChanged ? <DefaultChanged playbook={playbook} /> : null}
      {!playbook.builtin && extensionIds.includes(playbook.id) ? (
        <Notice tone="error">{d.playbooks.extensionClash.replace('{name}', playbook.id)}</Notice>
      ) : null}
      {playbook.builtin ? null : (
        <>
          <ControlRow label={d.playbooks.command} error={commandError}>
            <CommitInput
              value={command}
              aria-label={d.playbooks.command}
              aria-invalid={commandError ? true : undefined}
              className="h-7 w-72 text-ui-sm md:text-ui-sm"
              onCommit={(raw) => {
                const name = bareName(raw)
                if (name === playbook.id) return setCommandError(null)
                const problem = nameError(
                  name,
                  ownNames.filter((n) => n !== playbook.id),
                )
                setCommandError(problem)
                if (problem) return false
                save(name, fields, playbook.id)
                onRenamed(name)
                return undefined
              }}
            />
          </ControlRow>
          <ControlRow label={d.playbooks.description} error={descriptionError}>
            <CommitInput
              value={playbook.description}
              aria-label={d.playbooks.description}
              aria-invalid={descriptionError ? true : undefined}
              placeholder={d.playbooks.descriptionPlaceholder}
              className="h-7 w-72 text-ui-sm md:text-ui-sm"
              onCommit={(raw) => {
                const problem = playbookDescriptionProblem(raw)
                setDescriptionError(problem ? d.playbooks.descriptionProblems[problem] : null)
                if (problem) return false
                save(playbook.id, { ...fields, description: raw.trim() })
                return undefined
              }}
            />
          </ControlRow>
        </>
      )}
      <PlaybookPrompt
        key={`${playbook.id}:${playbook.text}`}
        text={playbook.text}
        label={d.playbooks.promptLabel.replace('{command}', command)}
        showProblems
        onCommit={(text) => setText(playbook.id, text)}
      />
    </SettingsGroup>
  )
}

export function DraftDetail({
  draft,
  ownNames,
  extensionIds,
  onChange,
  onCreated,
  onDiscard,
}: {
  draft: Draft
  ownNames: readonly string[]
  extensionIds: readonly string[]
  onChange: (draft: Draft) => void
  onCreated: (name: string) => void
  onDiscard: () => void
}): JSX.Element {
  const d = useDict()
  const save = useSettingsStore((s) => s.saveOwnPlaybook)
  const nameError = useNameError(extensionIds)
  const next = (patch: Partial<Draft>): void => {
    const merged = { ...draft, ...patch }
    const ready =
      playbookNameProblem(merged.name, ownNames, extensionIds) === null &&
      playbookDescriptionProblem(merged.description) === null &&
      playbookTextProblem(merged.text) === null
    if (!ready) {
      onChange(merged)
      return
    }
    save(merged.name, { description: merged.description.trim(), text: merged.text })
    onCreated(merged.name)
  }
  const nameMessage = draft.name === '' ? null : nameError(draft.name, ownNames)
  const descriptionProblem =
    draft.description === '' ? null : playbookDescriptionProblem(draft.description)
  return (
    <SettingsGroup
      title={d.playbooks.newPlaybook}
      action={
        <Button variant="outline" size="xs" onClick={onDiscard}>
          {d.playbooks.discardDraft}
        </Button>
      }
    >
      <ControlRow label={d.playbooks.command} error={nameMessage}>
        <CommitInput
          key={draft.name}
          value={draft.name === '' ? '' : `/${draft.name}`}
          aria-label={d.playbooks.command}
          aria-invalid={nameMessage ? true : undefined}
          placeholder="/release-check"
          className="h-7 w-72 text-ui-sm md:text-ui-sm"
          onCommit={(raw) => next({ name: bareName(raw) })}
        />
      </ControlRow>
      <ControlRow
        label={d.playbooks.description}
        error={descriptionProblem ? d.playbooks.descriptionProblems[descriptionProblem] : null}
      >
        <CommitInput
          key={draft.description}
          value={draft.description}
          aria-label={d.playbooks.description}
          placeholder={d.playbooks.descriptionPlaceholder}
          className="h-7 w-72 text-ui-sm md:text-ui-sm"
          onCommit={(raw) => next({ description: raw.trim() })}
        />
      </ControlRow>
      <PlaybookPrompt
        key={draft.text}
        text={draft.text}
        label={d.playbooks.newPlaybook}
        placeholder={d.playbooks.promptPlaceholder}
        showProblems={false}
        onCommit={(text) => next({ text })}
      />
    </SettingsGroup>
  )
}

export const canAddPlaybook = (ownCount: number): boolean => ownCount < OWN_PLAYBOOKS_MAX
