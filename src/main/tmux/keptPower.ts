interface PowerEvents {
  on(event: 'suspend' | 'resume', listener: () => void): unknown
}

interface PowerAware {
  suspend(): void
  resume(): void
}

export function watchPower(power: PowerEvents, kept: PowerAware): void {
  power.on('suspend', () => kept.suspend())
  power.on('resume', () => kept.resume())
}
