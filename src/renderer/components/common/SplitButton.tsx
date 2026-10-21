import { CaretDownIcon } from '@phosphor-icons/react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { ButtonGroup, ButtonGroupSeparator } from '@/components/ui/button-group'
import { DropdownMenu } from './Menu'

const CARET_SIZE = { sm: 'icon-sm', xs: 'icon-xs' } as const

export type SplitButtonSize = keyof typeof CARET_SIZE
type SplitButtonVariant = 'default' | 'outline'

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
        <Button type="button" variant={variant} size={CARET_SIZE[size]} aria-label={label}>
          <CaretDownIcon aria-hidden />
        </Button>
      }
    >
      {children}
    </DropdownMenu>
  )
}
