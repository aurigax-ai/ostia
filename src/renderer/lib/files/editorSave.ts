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
