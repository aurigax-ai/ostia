import { ListRow, type ListRowProps } from '@/components/common/ListRow'

export function SettingsListRow(props: Omit<ListRowProps, 'density'>): JSX.Element {
  return <ListRow {...props} density="settings" />
}
