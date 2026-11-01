import type { JSX } from 'react'
import { ListRow, type ListRowProps } from '@/components/common/ListRow'

type WithoutDensity<T> = T extends unknown ? Omit<T, 'density'> : never

export function SettingsListRow(props: WithoutDensity<ListRowProps>): JSX.Element {
  return <ListRow {...(props as ListRowProps)} density="settings" />
}
