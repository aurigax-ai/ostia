import { CaretDownIcon, CubeIcon } from '@phosphor-icons/react'
import type { JSX } from 'react'
import { Hint } from '@/components/common/Hint'
import { DropdownMenu, MenuLabel, MenuRadioItem } from '@/components/common/Menu'
import { Button } from '@/components/ui/button'
import { ContextMenuGroup, ContextMenuRadioGroup } from '@/components/ui/context-menu'
import { fmt, useDict } from '@/lib/app/useDict'
import { cn } from '@/lib/utils'
import { useAgentStore } from '@/stores/agent/agentStore'
import { useSettingsStore } from '@/stores/app/settingsStore'

const SEPARATOR = '\u0000'

export function AgentModelSelect({ sessionId }: { sessionId: string }): JSX.Element | null {
  const d = useDict()
  const providers = useSettingsStore((s) => s.agent.providers)
  const current = useAgentStore((s) => s.models[sessionId])
  if (!current) return null
  const label = `${current.provider} · ${current.model}`
  return (
    <DropdownMenu
      side="top"
      className="max-w-96"
      trigger={
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-label={fmt(d.chat.modelNow, { model: label })}
          className={cn(
            'chat-model-trigger h-6 min-w-0 max-w-48 shrink gap-1 px-1.5 text-fg-muted text-ui-xs',
          )}
        >
          <CubeIcon aria-hidden />
          <Hint label={label}>
            <span className="min-w-0 truncate">{current.model}</span>
          </Hint>
          <CaretDownIcon aria-hidden className="size-4 @max-3xs:hidden" />
        </Button>
      }
    >
      <ContextMenuRadioGroup
        value={`${current.provider}${SEPARATOR}${current.model}`}
        onValueChange={(value) => {
          const [provider, model] = String(value).split(SEPARATOR)
          if (provider && model) useAgentStore.getState().setModel(sessionId, { provider, model })
        }}
      >
        {providers.map((provider) => (
          <ContextMenuGroup key={provider.id}>
            <MenuLabel>{provider.name}</MenuLabel>
            {provider.models.map((model) => (
              <MenuRadioItem
                key={model}
                value={`${provider.id}${SEPARATOR}${model}`}
                closeOnClick
                className="font-mono text-ui-sm"
              >
                {model}
              </MenuRadioItem>
            ))}
          </ContextMenuGroup>
        ))}
      </ContextMenuRadioGroup>
    </DropdownMenu>
  )
}
