import type { ParkOutcome } from './park'

interface ParkApi {
  pane: (workspaceId: string, paneId: string, titlePinned: boolean) => Promise<ParkOutcome>
}

export interface ParkBridge {
  park: ParkApi
}
