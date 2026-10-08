import type { Page } from './test'

export const RED_BLOCKS = "clear; printf '\\033[38;2;255;0;0m%s\\n%s\\n%s\\033[0m\\n' ███ ███ ███"

export async function textPainted(png: Buffer, page: Page): Promise<boolean> {
  return page.evaluate(async (b64) => {
    const img = new Image()
    img.src = `data:image/png;base64,${b64}`
    await img.decode()
    const canvas = document.createElement('canvas')
    canvas.width = img.width
    canvas.height = img.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return false
    ctx.drawImage(img, 0, 0)
    const { data, width, height } = ctx.getImageData(0, 0, img.width, img.height)
    const corner = ((height - 1) * width + width - 1) * 4
    const differs = (i: number): boolean =>
      Math.abs(data[i] - data[corner]) +
        Math.abs(data[i + 1] - data[corner + 1]) +
        Math.abs(data[i + 2] - data[corner + 2]) >
      96
    let left = width
    let right = -1
    let top = height
    let bottom = -1
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (!differs((y * width + x) * 4)) continue
        left = Math.min(left, x)
        right = Math.max(right, x)
        top = Math.min(top, y)
        bottom = Math.max(bottom, y)
      }
    }
    return right - left > bottom - top
  }, png.toString('base64'))
}

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
