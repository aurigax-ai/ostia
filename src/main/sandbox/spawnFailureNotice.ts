import type { RequirementsReport } from '../../shared/systemRequirements'
import { missingPackages } from './spawnBanner'

export interface SpawnFailureDeps {
  notify: (input: { title: string; body: string }, onClick: () => void) => void
  showRequirements: (workspaceId: string, report: RequirementsReport) => void
  report: () => RequirementsReport
}

export function reportSandboxSpawnFailure(
  deps: SpawnFailureDeps,
  workspaceId: string,
  errors: readonly string[],
): void {
  const packages = missingPackages(errors)
  if (packages.length === 0) return
  deps.notify(
    {
      title: 'Sandbox needs software',
      body: `Install ${packages.join(', ')} to start this sandboxed workspace's terminals.`,
    },
    () => deps.showRequirements(workspaceId, deps.report()),
  )
}
