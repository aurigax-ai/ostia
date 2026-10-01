import { PRODUCT_NAME } from './product'

export const EXTENSION_API_VERSION = '1.0'
export const EXTENSION_API_PATTERN = /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/
export const EXTENSION_API_ENV = 'PINE_EXTENSION_API'

export interface ApiVersion {
  major: number
  minor: number
}

export function parseApiVersion(value: unknown): ApiVersion | null {
  if (typeof value !== 'string') return null
  const match = EXTENSION_API_PATTERN.exec(value)
  return match ? { major: Number(match[1]), minor: Number(match[2]) } : null
}

export function isApiCompatible(required: ApiVersion, provided: ApiVersion): boolean {
  return required.major === provided.major && required.minor <= provided.minor
}

export function apiProblem(
  required: unknown,
  provided: string = EXTENSION_API_VERSION,
): string | null {
  const wanted = parseApiVersion(required)
  if (!wanted) return 'api must be an extension API version such as 1.0'
  const have = parseApiVersion(provided)
  if (have && isApiCompatible(wanted, have)) return null
  return `needs extension API ${required}; this ${PRODUCT_NAME} provides ${provided}`
}
