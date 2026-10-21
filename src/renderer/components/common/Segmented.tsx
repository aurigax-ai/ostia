import type { Icon as IconComponent } from '@phosphor-icons/react'
import { Hint } from '@/components/common/Hint'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'

export interface SegmentedOption<T extends string> {
  value: T
  label: string
  icon?: IconComponent
}

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  iconOnly = false,
}: {
  label: string
  value: T
  options: SegmentedOption<T>[]
  onChange: (value: T) => void
  iconOnly?: boolean
}): JSX.Element {
  return (
    <ButtonGroup aria-label={label}>
      {options.map((o) => {
        const Icon = o.icon
        const button = (
          <Button
            key={o.value}
            variant="outline"
            size={iconOnly ? 'icon-sm' : 'sm'}
            className="text-fg-muted aria-pressed:bg-surface-3 aria-pressed:text-fg dark:aria-pressed:bg-surface-3"
            aria-pressed={o.value === value}
            aria-label={iconOnly ? o.label : undefined}
            onClick={() => onChange(o.value)}
          >
            {Icon ? <Icon aria-hidden /> : null}
            {iconOnly ? null : o.label}
          </Button>
        )
        return iconOnly ? (
          <Hint key={o.value} label={o.label}>
            {button}
          </Hint>
        ) : (
          button
        )
      })}
    </ButtonGroup>
  )
}
