import { LEGACY_PRODUCT_NAME, PRODUCT_NAME } from './product'

export const LEGACY_THEME_IDS: Readonly<Record<string, string>> = {
  [`${LEGACY_PRODUCT_NAME}-light`]: `${PRODUCT_NAME}-light`,
}

export function currentThemeId(id: string): string {
  return Object.hasOwn(LEGACY_THEME_IDS, id) ? (LEGACY_THEME_IDS[id] as string) : id
}

export function currentProductValue(value: unknown): unknown {
  return value === LEGACY_PRODUCT_NAME ? PRODUCT_NAME : value
}
