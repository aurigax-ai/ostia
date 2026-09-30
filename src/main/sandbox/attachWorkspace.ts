export type AttachWorkspace = { ok: true; workspaceId: string } | { ok: false }

export function attachWorkspace(known: string | undefined, requested: string): AttachWorkspace {
  if (known && requested && known !== requested) return { ok: false }
  return { ok: true, workspaceId: known || requested }
}
