let human = false

export function markHumanInput(): void {
  human = true
  queueMicrotask(() => {
    human = false
  })
}

export function isHumanInput(): boolean {
  return human
}
