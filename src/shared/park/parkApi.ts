import type { ParkOutcome } from './park'

interface ParkApi {
  pane: (workspaceId: string, paneId: string) => Promise<ParkOutcome>
}

export interface ParkBridge {
  park: ParkApi
}
