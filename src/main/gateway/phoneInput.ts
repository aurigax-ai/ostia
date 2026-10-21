export function phoneInputNoter(
  waitingSince: (paneId: string) => number | undefined,
  inputSent: (paneId: string) => void,
): (paneId: string) => void {
  const noted = new Map<string, number>()
  return (paneId) => {
    const since = waitingSince(paneId)
    if (since === undefined) {
      noted.delete(paneId)
      return
    }
    if (noted.get(paneId) === since) return
    noted.set(paneId, since)
    inputSent(paneId)
  }
}
