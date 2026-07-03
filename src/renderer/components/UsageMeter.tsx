interface UsageMeterProps {
  label: string
  filled: number
  total: number
  value?: string
  tone?: 'accent' | 'ok' | 'attn'
}

/**
 * A segmented dotted/filled budget meter (ref merge: ambient agent telemetry —
 * context window, weekly usage). Quiet by default; it's data, not decoration.
 */
export function UsageMeter({
  label,
  filled,
  total,
  value,
  tone = 'accent',
}: UsageMeterProps): JSX.Element {
  const cells = Array.from({ length: total }, (_, i) => i < filled)
  return (
    <div className="meter" title={`${label}: ${value ?? `${filled}/${total}`}`}>
      <span className="meter-label">{label}</span>
      <span className={`meter-track ${tone}`}>
        {cells.map((on, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length positional cells, never reordered
          <span key={`cell-${i}`} className={`cell${on ? ' on' : ''}`} />
        ))}
      </span>
      {value ? <span className="meter-value">{value}</span> : null}
    </div>
  )
}
