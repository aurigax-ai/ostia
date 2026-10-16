import type { ArtifactListing, ArtifactRestore, ArtifactVersion, ArtifactVersionContent } from './artifacts'
import type { PortableAction, PortableRequest, PortableResult } from './portable'

interface ArtifactsApi {
  list: (workspaceId: string) => Promise<ArtifactListing | null>
  pad: (workspaceId: string) => Promise<string | null>
  reveal: (workspaceId: string) => void
  onChanged: (cb: (workspaceId: string) => void) => () => void
  portable: (action: PortableAction, request: PortableRequest) => Promise<PortableResult>
  versions: (workspaceId: string, path: string) => Promise<ArtifactVersion[] | null>
  version: (workspaceId: string, path: string, id: string) => Promise<ArtifactVersionContent | null>
  restore: (workspaceId: string, path: string, id: string) => Promise<ArtifactRestore | null>
  producers: (workspaceId: string) => Promise<Record<string, string> | null>
}

export interface ArtifactsBridge {
  artifacts: ArtifactsApi
}
