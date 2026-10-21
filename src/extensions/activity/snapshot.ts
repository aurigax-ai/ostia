import type { ParkedView } from './parkedView'
import type { RememberView } from './rememberView'
import type { PanelModel } from './view'

export type PanelSnapshot =
  | { unchanged: true }
  | (PanelModel & { rev: string; remember: RememberView; parked: ParkedView[] })
