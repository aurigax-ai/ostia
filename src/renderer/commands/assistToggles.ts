import type { Dict } from '../i18n/dict'
import { fmt } from '../i18n/useDict'
import { toggleAssistFeature, toggleCommandId } from '../lib/assistFeatures'
import { useAssistStore } from '../stores/assistStore'
import { type CommandWording, commands, wordedBy } from './registry'

const registered = new Set<string>()

interface ToggleCommand {
  run: () => void
  wording: (d: Dict) => CommandWording
}

function syncToggleCommands(): void {
  const wanted = new Map<string, ToggleCommand>()
  for (const ext of useAssistStore.getState().overview) {
    for (const feature of ext.features) {
      wanted.set(toggleCommandId(ext.extId, feature), {
        run: () => {
          const current = useAssistStore
            .getState()
            .overview.find((e) => e.extId === ext.extId)
            ?.features.find((f) => f.id === feature.id)
          if (current) void toggleAssistFeature(ext.extId, current)
        },
        wording: (d) => ({
          title: fmt(d.assistMenu.toggleTitle, {
            feature: d.assistMenu.feature[feature.id] ?? feature.id,
          }),
          category: d.commands.categories.assistant,
        }),
      })
    }
  }
  for (const id of [...registered]) {
    if (wanted.has(id)) continue
    commands.unregister(id)
    registered.delete(id)
  }
  for (const [id, { run, wording }] of wanted) {
    if (registered.has(id) || commands.has(id)) continue
    commands.register({ id, ...wordedBy(wording), target: 'none', run })
    registered.add(id)
  }
}

export function startAssistToggleCommands(): () => void {
  syncToggleCommands()
  return useAssistStore.subscribe((s, prev) => {
    if (s.overview !== prev.overview) syncToggleCommands()
  })
}
