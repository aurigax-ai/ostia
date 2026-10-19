export type WorktreeShareMap = Record<string, string[]>

export interface WorktreeShareApi {
  snapshot: () => Promise<WorktreeShareMap>
  onChange: (cb: (map: WorktreeShareMap) => void) => () => void
}
