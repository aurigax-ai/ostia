export interface AutoSave {
  schedule: () => void
  cancel: () => void
}

export function createAutoSave(save: () => void, delayMs: number): AutoSave {
  let timer: ReturnType<typeof setTimeout> | null = null
  const cancel = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
  }
  return {
    cancel,
    schedule: () => {
      cancel()
      timer = setTimeout(() => {
        timer = null
        save()
      }, delayMs)
    },
  }
}

export async function saveFormatted({
  formatOnSave,
  format,
  write,
}: {
  formatOnSave: boolean
  format: () => Promise<unknown>
  write: () => Promise<boolean>
}): Promise<boolean> {
  if (formatOnSave) await format().catch(() => undefined)
  return write()
}
