import { Button } from '@/components/ui/button'
import { ButtonGroup, ButtonGroupSeparator } from '@/components/ui/button-group'
import { CaretDownIcon } from '@phosphor-icons/react'
import type { ReactNode } from 'react'
import { DropdownMenu } from './Menu'

const CARET_SIZE = { sm: 'icon-sm', xs: 'icon-xs' } as const

export type SplitButtonSize = keyof typeof CARET_SIZE

export function SplitButton({
  label,
  main,
  children,
}: {
  label: string
  main: ReactNode
  children?: ReactNode
}): JSX.Element {
  return (
    <ButtonGroup aria-label={label}>
      {main}
      {children ? (
        <>
          <ButtonGroupSeparator className="bg-on-brand/25" />
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
}: {
  label: string
  size: SplitButtonSize
  children: ReactNode
}): JSX.Element {
  return (
    <DropdownMenu
      trigger={
        <Button type="button" size={CARET_SIZE[size]} aria-label={label}>
          <CaretDownIcon aria-hidden />
        </Button>
      }
    >
      {children}
    </DropdownMenu>
  )
}
