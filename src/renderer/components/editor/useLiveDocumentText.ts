import { useEffect } from 'react'

export function useLiveDocumentText(paneId: string, filePath: string, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return
    let stop = (): void => {}
    let cancelled = false
    void import('./liveDocument').then(({ followLiveDocument }) => {
      if (!cancelled) stop = followLiveDocument(paneId, filePath)
    })
    return () => {
      cancelled = true
      stop()
    }
  }, [paneId, filePath, enabled])
}
