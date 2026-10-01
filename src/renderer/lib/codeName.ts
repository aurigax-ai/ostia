const ADJECTIVES = [
  'amber',
  'brisk',
  'calm',
  'cobalt',
  'coral',
  'crisp',
  'dusky',
  'eager',
  'fuzzy',
  'gentle',
  'golden',
  'hazel',
  'indigo',
  'jolly',
  'keen',
  'lively',
  'lucky',
  'mellow',
  'misty',
  'nimble',
  'opal',
  'plucky',
  'quiet',
  'rustic',
  'silver',
  'snug',
  'sunny',
  'swift',
  'tidal',
  'velvet',
  'witty',
  'zesty',
] as const

const NOUNS = [
  'acorn',
  'badger',
  'birch',
  'comet',
  'cricket',
  'dune',
  'ember',
  'falcon',
  'fern',
  'finch',
  'glacier',
  'harbor',
  'heron',
  'juniper',
  'kestrel',
  'lagoon',
  'lantern',
  'maple',
  'meadow',
  'otter',
  'pebble',
  'quartz',
  'raven',
  'reef',
  'sparrow',
  'spruce',
  'thistle',
  'tundra',
  'walnut',
  'willow',
  'wren',
  'yarrow',
] as const

const pick = <T>(list: readonly T[], random: () => number): T =>
  list[Math.min(list.length - 1, Math.floor(random() * list.length))]

export function codeName(taken: ReadonlySet<string>, random: () => number = Math.random): string {
  for (let attempt = 0; attempt < ADJECTIVES.length * NOUNS.length; attempt += 1) {
    const name = `${pick(ADJECTIVES, random)}-${pick(NOUNS, random)}`
    if (!taken.has(name)) return name
  }
  const base = `${ADJECTIVES[0]}-${NOUNS[0]}`
  let n = 2
  while (taken.has(`${base}-${n}`)) n += 1
  return `${base}-${n}`
}
