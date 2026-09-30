export interface FolderNode<T> {
  kind: 'folder'
  name: string
  path: string
  count: number
  children: TreeNode<T>[]
}

export interface FileNode<T> {
  kind: 'file'
  name: string
  path: string
  item: T
}

export type TreeNode<T> = FolderNode<T> | FileNode<T>

interface Draft<T> {
  folders: Map<string, Draft<T>>
  files: FileNode<T>[]
}

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

function emptyDraft<T>(): Draft<T> {
  return { folders: new Map(), files: [] }
}

function finish<T>(draft: Draft<T>, prefix: string): TreeNode<T>[] {
  const folders: FolderNode<T>[] = []
  for (const [segment, child] of draft.folders) {
    let name = segment
    let node = child
    while (node.files.length === 0 && node.folders.size === 1) {
      const [nextName, next] = [...node.folders][0]
      name = `${name}/${nextName}`
      node = next
    }
    const path = prefix ? `${prefix}/${name}` : name
    const children = finish(node, path)
    const count = children.reduce((sum, c) => sum + (c.kind === 'folder' ? c.count : 1), 0)
    folders.push({ kind: 'folder', name, path, count, children })
  }
  folders.sort((a, b) => byName.compare(a.name, b.name))
  const files = [...draft.files].sort((a, b) => byName.compare(a.name, b.name))
  return [...folders, ...files]
}

export function buildFileTree<T extends { path: string }>(items: T[]): TreeNode<T>[] {
  const root = emptyDraft<T>()
  for (const item of items) {
    const parts = item.path.split('/').filter(Boolean)
    const name = parts.pop()
    if (!name) continue
    let draft = root
    for (const part of parts) {
      let next = draft.folders.get(part)
      if (!next) {
        next = emptyDraft<T>()
        draft.folders.set(part, next)
      }
      draft = next
    }
    draft.files.push({ kind: 'file', name, path: item.path, item })
  }
  return finish(root, '')
}
