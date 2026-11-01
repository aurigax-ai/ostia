import { removedPlaybookIds, resolvePlaybooks } from '@shared/agents/playbooks'
import { type JSX, useMemo, useState } from 'react'
import { Notice } from '@/components/common/Notice'
import { TextLink } from '@/components/common/TextLink'
import { SettingsList } from '@/components/settingsKit/SettingsList'
import { SettingsListRow } from '@/components/settingsKit/SettingsListRow'
import { SettingsPage } from '@/components/settingsKit/SettingsPage'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { fmt, useDict } from '@/lib/app/useDict'
import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useExtensionsStore } from '@/stores/extensions/extensionsStore'
import {
  canAddPlaybook,
  type Draft,
  DraftDetail,
  EMPTY_DRAFT,
  PlaybookDetail,
} from './PlaybookDetail'

const DRAFT_ID = ''

export function PlaybooksSection(): JSX.Element {
  const d = useDict()
  const playbooks = useSettingsStore((s) => s.playbooks)
  const setEnabled = useSettingsStore((s) => s.setPlaybookEnabled)
  const list = useMemo(() => resolvePlaybooks(playbooks), [playbooks])
  const removed = useMemo(
    () => (playbooks.enabled.onboard ? [] : removedPlaybookIds(playbooks)),
    [playbooks],
  )
  const ownNames = useMemo(() => Object.keys(playbooks.own), [playbooks.own])
  const extensions = useExtensionsStore((x) => x.list)
  const extensionIds = useMemo(() => extensions.flatMap((e) => e.agentSkills), [extensions])
  const [selected, setSelected] = useState(list[0]?.id ?? DRAFT_ID)
  const [draft, setDraft] = useState<Draft | null>(null)
  const current = list.find((p) => p.id === selected)
  const show = (id: string): void => {
    setSelected(id)
    setDraft(null)
  }
  const mark = (p: (typeof list)[number]): string | undefined => {
    const parts = [
      p.builtin ? null : d.playbooks.yours,
      p.edited ? d.playbooks.edited : null,
      p.unaccepted !== null ? d.playbooks.changedElsewhereShort : null,
    ]
    return parts.filter(Boolean).join(' · ') || undefined
  }
  const rowClass = (on: boolean): string =>
    cn(
      'relative isolate',
      on &&
        'before:absolute before:inset-y-0 before:-inset-x-2 before:-z-10 before:rounded-md before:bg-surface-2',
    )
  return (
    <SettingsPage title={d.playbooks.title} desc={d.playbooks.desc}>
      {removed.map((id) => (
        <Notice
          key={id}
          actions={
            <TextLink size="xs" onClick={() => setEnabled('onboard', true)}>
              {d.playbooks.enableOnboard}
            </TextLink>
          }
        >
          {fmt(d.playbooks.removed, { name: id })}
        </Notice>
      ))}
      <SettingsList
        label={d.playbooks.listLabel}
        empty={d.playbooks.noPlaybooks}
        add={
          <Button
            variant="outline"
            size="xs"
            disabled={!canAddPlaybook(ownNames.length)}
            onClick={() => {
              setDraft(EMPTY_DRAFT)
              setSelected(DRAFT_ID)
            }}
          >
            {d.playbooks.newPlaybook}
          </Button>
        }
      >
        {list.map((p) => {
          const on = p.id === selected && draft === null
          return (
            <SettingsListRow
              key={p.id}
              className={rowClass(on)}
              title={
                <button
                  type="button"
                  aria-current={on ? 'true' : undefined}
                  className="before:absolute before:inset-0"
                  onClick={() => show(p.id)}
                >
                  /{p.id}
                </button>
              }
              meta={mark(p)}
              detail={
                p.builtin
                  ? (d.playbooks.descriptions[p.id as keyof typeof d.playbooks.descriptions] ??
                    p.description)
                  : p.description
              }
              actions={
                <span className="relative z-10">
                  <Switch
                    checked={p.enabled}
                    disabled={!p.builtin && (p.unaccepted !== null || extensionIds.includes(p.id))}
                    onCheckedChange={(next) => setEnabled(p.id, next)}
                    aria-label={`/${p.id}`}
                  />
                </span>
              }
            />
          )
        })}
        {draft ? (
          <SettingsListRow
            key="draft"
            className={rowClass(true)}
            title={<span className="text-fg-muted">{d.playbooks.newPlaybook}</span>}
            actions={<Switch checked={false} disabled aria-label={d.playbooks.newPlaybook} />}
          />
        ) : null}
      </SettingsList>
      {draft ? (
        <DraftDetail
          draft={draft}
          ownNames={ownNames}
          extensionIds={extensionIds}
          onChange={setDraft}
          onCreated={show}
          onDiscard={() => show(list[0]?.id ?? DRAFT_ID)}
        />
      ) : current ? (
        <PlaybookDetail
          key={current.id}
          playbook={current}
          ownNames={ownNames}
          extensionIds={extensionIds}
          onRenamed={show}
        />
      ) : null}
    </SettingsPage>
  )
}
