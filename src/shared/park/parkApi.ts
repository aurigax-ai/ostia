import type { ParkOutcome } from './park'

interface ParkApi {
  pane: (workspaceId: string, paneId: string, note: string) => Promise<ParkOutcome>
}

export interface ParkBridge {
  park: ParkApi
}
