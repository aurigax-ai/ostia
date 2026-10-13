type RegionCaptureStarter = () => void

const starters = new Map<string, RegionCaptureStarter>()

export function registerRegionCapture(paneId: string, start: RegionCaptureStarter): () => void {
  starters.set(paneId, start)
  return () => {
    if (starters.get(paneId) === start) starters.delete(paneId)
  }
}

export function startRegionCapture(paneId: string): boolean {
  const start = starters.get(paneId)
  if (!start) return false
  start()
  return true
}
