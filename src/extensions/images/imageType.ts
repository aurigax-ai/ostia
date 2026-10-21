const SVG_TYPE = 'image/svg+xml'

export function imageBlobType(name: string): string {
  return /\.svg$/i.test(name) ? SVG_TYPE : ''
}
