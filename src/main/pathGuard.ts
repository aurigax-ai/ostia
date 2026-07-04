/**
 * Path-traversal guard for the main-process `fs:*` IPC handlers.
 *
 * The existing handlers run user-supplied paths through `expandHome()` and hand the
 * result straight to `readFileSync`/`writeFileSync`/`readdirSync` with NO containment
 * check — so a renderer (or a compromised extension) can read `/etc/passwd` or escape a
 * workspace with `../`. This module is the intended fix: pure `node:path`/`node:os`
 * helpers that expand `~`, normalise away `..`, and verify the result lives inside an
 * allow-list of roots. It has no fs side-effects (no `stat`/`realpath`), so it is
 * deterministic and unit-testable in a plain node env; the handlers can be wired to it
 * later without changing this contract.
 *
 * NOTE: this is pure lexical containment. It does not follow symlinks — a symlink whose
 * target escapes a root is out of scope here (would need `fs.realpathSync` at call time).
 */
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

/**
 * Expand a leading `~` / `~/` to the current user's home directory.
 *
 * Mirrors the intent of the helper in `main/index.ts`: `~` alone → home, `~/x` →
 * `<home>/x`. A bare `~user` form or a `~` anywhere but the start is left untouched.
 *
 * @param p - Raw path, possibly starting with `~`.
 * @returns The path with a leading `~` expanded, or `p` unchanged when there is none.
 */
export function expandHome(p: string): string {
  const home = homedir()
  if (p === '~') return home
  if (p.startsWith('~/')) return join(home, p.slice(2))
  return p
}

/**
 * Test whether an already-resolved absolute `target` lives inside an already-resolved
 * absolute `root`.
 *
 * This is the boundary-correct check: it treats `target === root` as inside, and
 * otherwise requires `target` to start with `root + sep`. That `sep` is what stops the
 * classic prefix bug — a naive `target.startsWith(root)` would wrongly accept the sibling
 * `/home/u/app-secrets/x` for the root `/home/u/app`, because it shares the string prefix
 * `/home/u/app` without being a child of it.
 *
 * @param root - Absolute, resolved root directory.
 * @param target - Absolute, resolved candidate path.
 * @returns `true` iff `target` is `root` itself or a descendant of it.
 */
function isInsideRoot(root: string, target: string): boolean {
  if (target === root) return true
  // `resolve` strips a trailing slash from every path except the fs root (`/`), which
  // already ends in `sep`; guard against doubling it so `/` contains everything.
  const rootWithSep = root.endsWith(sep) ? root : root + sep
  return target.startsWith(rootWithSep)
}

/**
 * Expand `~`, resolve `inputPath` to an absolute, normalised path (collapsing any `..`),
 * and return it **iff** it resolves inside at least one of the allowed `roots`.
 *
 * Relative inputs resolve against `process.cwd()` (matching what `fs` would actually
 * read), so a bare `../../etc/passwd` lands outside a project root and is rejected. Each
 * root is itself `~`-expanded and resolved, so trailing slashes and `~` roots work too.
 *
 * @param inputPath - User-supplied path (absolute, relative, or `~`-prefixed).
 * @param roots - Allow-list of directory roots; a path inside ANY root is accepted.
 * @returns The resolved absolute path when it is contained by a root, else `null`.
 */
export function resolveSafe(inputPath: string, roots: string[]): string | null {
  const resolved = resolve(expandHome(inputPath))
  for (const root of roots) {
    const resolvedRoot = resolve(expandHome(root))
    if (isInsideRoot(resolvedRoot, resolved)) return resolved
  }
  return null
}

/**
 * Boolean form of {@link resolveSafe}: `true` when `inputPath` resolves inside one of the
 * `roots`, `false` when it escapes every root.
 *
 * @param inputPath - User-supplied path (absolute, relative, or `~`-prefixed).
 * @param roots - Allow-list of directory roots.
 * @returns Whether the path is contained by at least one root.
 */
export function isPathAllowed(inputPath: string, roots: string[]): boolean {
  return resolveSafe(inputPath, roots) !== null
}
