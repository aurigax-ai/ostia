export function extensionTag(id: string, version: string): string

export function parseExtensionTag(tag: string): { id: string; version: string } | null

export function releaseProblems(
  tag: string,
  from: { listed: string[]; versionOf: (id: string) => string },
): string[]

export function sdkTag(version: string): string

export function parseSdkTag(tag: string): { version: string } | null

export function sdkReleaseProblems(tag: string, version: string): string[]
