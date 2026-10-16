import type { Diagnostic } from 'vscode-languageserver-protocol'

export interface DiagnosticReport {
  kind?: string
  resultId?: string
  items?: Diagnostic[]
  relatedDocuments?: Record<string, DiagnosticReport>
}

function diagnosticIdentity(diagnostic: Diagnostic): string {
  return JSON.stringify([
    diagnostic.range,
    diagnostic.severity ?? null,
    diagnostic.code ?? null,
    diagnostic.source ?? null,
    diagnostic.message,
  ])
}

export function mergeDiagnostics(
  pushed: readonly Diagnostic[],
  pulled: readonly Diagnostic[],
): Diagnostic[] {
  const seen = new Set<string>()
  const out: Diagnostic[] = []
  for (const diagnostic of [...pushed, ...pulled]) {
    const identity = diagnosticIdentity(diagnostic)
    if (seen.has(identity)) continue
    seen.add(identity)
    out.push(diagnostic)
  }
  return out
}
