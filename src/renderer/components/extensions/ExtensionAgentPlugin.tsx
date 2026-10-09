import { fmt, useDict } from '@/i18n/useDict'
import type { ExtensionInfo } from '@shared/extensions'

export function ExtensionAgentPlugin({
  ext,
  explain,
}: {
  ext: ExtensionInfo
  explain: boolean
}): JSX.Element | null {
  const d = useDict()
  if (ext.agentSkills.length === 0 && ext.agentHooks.length === 0) return null
  const commandTitle = (id: string) => ext.commands.find((c) => c.id === id)?.title ?? id
  return (
    <section aria-label={d.extensions.agentPluginTitle} className="flex flex-col gap-0.5">
      {explain ? (
        <>
          <p className="text-fg text-ui-sm">{d.extensions.agentPluginTitle}</p>
          <p className="text-fg-muted text-ui-sm">{d.extensions.agentPluginNote}</p>
        </>
      ) : null}
      {ext.agentSkills.length > 0 ? (
        <p className="text-fg-muted text-ui-xs">
          {fmt(d.extensions.agentSkillsList, { list: ext.agentSkills.join(', ') })}
        </p>
      ) : null}
      {ext.agentHooks.length > 0 ? (
        <ul className="flex flex-col">
          {ext.agentHooks.map((hook) => (
            <li key={`${hook.event}:${hook.command}`} className="text-fg-muted text-ui-xs">
              {fmt(d.extensions.agentHook, {
                event: hook.event,
                command: commandTitle(hook.command),
                agents: hook.agents.join(', '),
              })}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}
