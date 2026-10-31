import {
  PANE_CHIP_ITEMS_MAX,
  type PaneChipItem,
} from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import type { ForwardRow } from '../../../shared/remote/remotePorts'

export function portItems(rows: readonly ForwardRow[]): PaneChipItem[] {
  return rows.slice(0, PANE_CHIP_ITEMS_MAX).map((row) => {
    const port = {
      remote: row.remote,
      ...(row.local === undefined ? {} : { local: row.local }),
      ...(row.error ? { error: row.error } : {}),
    }
    const detail = row.name ? { detail: row.name } : {}
    if (row.local === undefined) return { text: `:${row.remote}`, ...detail, port }
    return {
      text: `:${row.remote} → localhost:${row.local}`,
      ...detail,
      url: `http://localhost:${row.local}`,
      port,
    }
  })
}
