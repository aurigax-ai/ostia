export interface ModelEntry {
  id: string
  name?: string
  description?: string
  installed?: boolean
  loaded?: boolean
  busy?: boolean
  idleSecs?: number
}

export interface PanelState {
  provider: string
  endpoint: string
  fastModel: string
  chatModel: string
  problem: string | null
  lifecycle: boolean
  models: ModelEntry[]
  modelsError?: string
}
