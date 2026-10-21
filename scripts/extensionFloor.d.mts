export function exceedsFloor(declared: string, floor: string): boolean

export function floorProblems(from: {
  declared: string
  appApi: string
  sdk: string
  sdkApi: string
}): string[]

export function latestStableAppTag(
  releases: { tag_name: string; draft: boolean; prerelease: boolean }[],
): string | null
