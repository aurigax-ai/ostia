import { ClipboardItem, clipboard, nativeImage } from 'electron'

export const phoneScreenLines = 40

export async function withClipboardImage(
  bytes: Buffer,
  paste: () => Promise<boolean>,
): Promise<boolean | null> {
  const image = nativeImage.createFromBuffer(bytes)
  if (image.isEmpty()) return null
  const prior = await clipboard.read()
  await clipboard.write([
    new ClipboardItem({ 'image/png': new Blob([new Uint8Array(image.toPNG())]) }),
  ])
  try {
    return await paste()
  } finally {
    if (prior.length > 0) await clipboard.write(prior)
    else await clipboard.clear()
  }
}
