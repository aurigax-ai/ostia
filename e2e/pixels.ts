import type { Page } from './test'

export async function redRowGaps(png: Buffer, page: Page): Promise<number> {
  return page.evaluate(async (b64) => {
    const img = new Image()
    img.src = `data:image/png;base64,${b64}`
    await img.decode()
    const canvas = document.createElement('canvas')
    canvas.width = img.width
    canvas.height = img.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return -1
    ctx.drawImage(img, 0, 0)
    const { data, width, height } = ctx.getImageData(0, 0, img.width, img.height)
    const isRed = (x: number, y: number): boolean => {
      const i = (y * width + x) * 4
      return data[i] > 200 && data[i + 1] < 60 && data[i + 2] < 60
    }
    let column = -1
    for (let x = 0; x < width && column < 0; x++) {
      for (let y = 0; y < height; y++) {
        if (isRed(x, y)) {
          column = x + 4
          break
        }
      }
    }
    if (column < 0) return -1
    const rows: number[] = []
    for (let y = 0; y < height; y++) if (isRed(column, y)) rows.push(y)
    let gaps = 0
    for (let i = 1; i < rows.length; i++) if (rows[i] - rows[i - 1] > 1) gaps++
    return gaps
  }, png.toString('base64'))
}
