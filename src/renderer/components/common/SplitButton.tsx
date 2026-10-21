import { CaretDownIcon } from '@phosphor-icons/react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { ButtonGroup, ButtonGroupSeparator } from '@/components/ui/button-group'
import { DropdownMenu } from './Menu'

const CARET_SIZE = { sm: 'icon-sm', xs: 'icon-xs', '2xs': 'icon-2xs' } as const

export type SplitButtonSize = keyof typeof CARET_SIZE
type SplitButtonVariant = 'default' | 'outline' | 'ghost'

export function SplitButton({
  label,
  main,
  children,
  variant = 'default',
}: {
  label: string
  main: ReactNode
  children?: ReactNode
  variant?: SplitButtonVariant
}): JSX.Element {
  if (variant === 'ghost') {
    return (
      // biome-ignore lint/a11y/useSemanticElements: a fieldset draws a border and a legend; this is a bare button group
      <div role="group" aria-label={label} className="flex items-center">
        {main}
        {children ? (
          <>
            <ButtonGroupSeparator className="my-0 h-3.5 bg-line-strong" />
            {children}
          </>
        ) : null}
      </div>
    )
  }
  return (
    <ButtonGroup aria-label={label}>
      {main}
      {children ? (
        <>
          <ButtonGroupSeparator className={variant === 'default' ? 'bg-on-brand/25' : undefined} />
          {children}
        </>
      ) : null}
    </ButtonGroup>
  )
}

export function SplitButtonMenu({
  label,
  size,
  children,
  variant = 'default',
}: {
  label: string
  size: SplitButtonSize
  children: ReactNode
  variant?: SplitButtonVariant
}): JSX.Element {
  return (
    <DropdownMenu
      trigger={
        <Button
          type="button"
          variant={variant}
          size={CARET_SIZE[size]}
          className={size === '2xs' ? 'w-4!' : undefined}
          aria-label={label}
        >
          <CaretDownIcon aria-hidden />
        </Button>
      }
    >
      {children}
    </DropdownMenu>
  )
}
