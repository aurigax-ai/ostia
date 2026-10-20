export interface Interval {
  rate: number
  low: number
  high: number
}

const Z95 = 1.96

export function wilson(successes: number, total: number): Interval {
  if (total === 0) return { rate: 0, low: 0, high: 0 }
  const p = successes / total
  const z2 = Z95 * Z95
  const centre = (p + z2 / (2 * total)) / (1 + z2 / total)
  const spread =
    (Z95 * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))) / (1 + z2 / total)
  return { rate: p, low: Math.max(0, centre - spread), high: Math.min(1, centre + spread) }
}

export interface Pair {
  withRule: boolean
  without: boolean
}

export interface Difference {
  difference: number
  low: number
  high: number
}

const BOOTSTRAP_ROUNDS = 2000

function caseDifference(pairs: readonly Pair[]): number {
  return pairs.reduce((sum, p) => sum + Number(p.withRule) - Number(p.without), 0) / pairs.length
}

export function bootstrapDifference(
  cases: readonly (readonly Pair[])[],
  random: () => number,
  rounds = BOOTSTRAP_ROUNDS,
): Difference {
  const clusters = cases.filter((c) => c.length > 0).map(caseDifference)
  if (clusters.length === 0) return { difference: 0, low: 0, high: 0 }
  const mean = (sample: readonly number[]): number =>
    sample.reduce((sum, d) => sum + d, 0) / sample.length
  const draws: number[] = []
  for (let round = 0; round < rounds; round++) {
    draws.push(mean(clusters.map(() => clusters[Math.floor(random() * clusters.length)])))
  }
  draws.sort((a, b) => a - b)
  return {
    difference: mean(clusters),
    low: draws[Math.floor(rounds * 0.025)],
    high: draws[Math.min(rounds - 1, Math.floor(rounds * 0.975))],
  }
}
