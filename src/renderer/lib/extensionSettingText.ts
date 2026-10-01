import {
  type ExtensionInfo,
  type ExtensionSecretContribution,
  type ExtensionSettingContribution,
  PRODUCT_PLACEHOLDER,
} from '@shared/extensions'
import { PRODUCT_NAME } from '@shared/product'

export function withProductName(text: string, product: string = PRODUCT_NAME): string {
  return text.split(PRODUCT_PLACEHOLDER).join(product)
}

function isAcronym(word: string): boolean {
  return word.length > 1 && word === word.toUpperCase() && /[A-Z]/.test(word)
}

export function humanizeSettingKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => (isAcronym(word) ? word : word.toLowerCase()))
  const sentence = words.join(' ')
  return sentence.charAt(0).toUpperCase() + sentence.slice(1)
}

export function entryTitle(
  entry: ExtensionSettingContribution | ExtensionSecretContribution,
): string {
  return withProductName(entry.title ?? humanizeSettingKey(entry.key))
}

export function enumValueTitle(setting: ExtensionSettingContribution, value: string): string {
  const title = setting.valueTitles?.[value]
  return title ? withProductName(title) : value
}

export function extensionMatchesQuery(ext: ExtensionInfo, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const texts = [
    ext.name,
    ...ext.settings.flatMap((setting) => [entryTitle(setting), setting.key]),
    ...ext.secrets.flatMap((secret) => [entryTitle(secret), secret.key]),
  ]
  return texts.some((text) => text.toLowerCase().includes(q))
}
