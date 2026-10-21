const STATUS_MS = 4000

export function mountStatus(stage: HTMLElement): (text: string) => void {
  const status = document.createElement('div')
  status.className = 'ostia-media-status'
  status.setAttribute('role', 'status')
  status.hidden = true
  stage.append(status)
  let timer: ReturnType<typeof setTimeout> | undefined
  return (text) => {
    status.textContent = text
    status.hidden = false
    clearTimeout(timer)
    timer = setTimeout(() => {
      status.hidden = true
    }, STATUS_MS)
  }
}
