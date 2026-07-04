# Test Infrastructure & First Test Plan — Design

**Date:** 2026-07-03
**Status:** Approved design → implementation plan pending
**Scope:** Stand up the full testing pyramid (unit → store → component → E2E) for the `pine`
Terminal Workspace, plus a security-regression suite and a root `CLAUDE.md`.

---

## 1. Context & goals

`pine` is an Electron 33 app (main / preload / renderer) built with electron-vite, React 18,
zustand, xterm.js, Monaco, node-pty, and an LSP bridge (~6.3k LOC). Today it has **one** test
(`src/renderer/layout/tree.test.ts`, node-env pure logic) and a **minimal** `vitest.config.ts`
(`environment: 'node'`, `include: ['src/**/*.test.ts']`). `docs/ARCHITECTURE.md` §2 names the
intended test stack as **Vitest + Playwright (e2e later)** — this design realizes that.

**Goal:** a best-practice, layered test suite that gives high coverage-per-effort on the pure
logic and state layers, real-app confidence via E2E, and a documented security tripwire — wired
so `pnpm test` (unit+component) and `pnpm test:e2e` (Playwright) are the two entry points.

**Non-goals (this plan):** 100% coverage, testing generated shadcn/Base-UI `components/ui/**`,
CI pipeline config (GitHub Actions), visual-regression/screenshot diffing, and fixing the
security bug itself (we write the failing test; the fix is a separate task owned by `main`).

---

## 2. Constraints

- **Package manager: pnpm.** The repo carries both `package-lock.json` and
  `pnpm-lock.yaml` + `pnpm-workspace.yaml`; devDeps are added with **pnpm** (updates
  `pnpm-lock.yaml`), leaving `package-lock.json` untouched.
- **Mostly additive, low-conflict.** Another agent works in this same directory. Default to
  creating **new** files (tests, config, mocks, `CLAUDE.md`). Small testability edits to existing
  source are allowed only where they clearly help (e.g. exporting a pure helper) and are
  called out explicitly in the plan.
- **Vitest is 2.1.9.** The multi-environment feature in v2 is **`defineWorkspace`** (a
  `vitest.workspace.ts` file), *not* the `test.projects` key — that key is the Vitest 3 rename of
  the same concept. We keep `vitest.config.ts` as the shared base and add a workspace file that
  `extends` it. (Migration note: when the repo moves to Vitest 3, collapse the workspace file into
  a `test.projects` array.)
- **Coding conventions** (enforced by Biome 1.9.4): 2-space indent, single quotes, semicolons
  "asNeeded" (none unless required), `lineWidth: 100`, organized imports. TypeScript `strict`
  with `noUnusedLocals`/`noUnusedParameters` (prefix intentionally-unused params `_`). Path
  aliases `@/*` → `src/renderer/*`, `@shared/*` → `src/shared/*`. High JSDoc comment density is
  house style; explain the *why* on non-obvious test setup. Tests mirror the existing
  `tree.test.ts`: `describe` = unit under test, `it` = behavior in plain English.

---

## 3. Architecture — the testing pyramid

Six suites across two Vitest environments + one Playwright runner. The dividing principle:
**pure logic / state / parsers → node or jsdom unit tests; anything that renders xterm or Monaco
or streams a real pty → Playwright E2E against the built app.**

| Layer | Env | Targets | Notes |
|---|---|---|---|
| **L1 Unit** | node | `layout/tree` (extend), `main/shellIntegration`, `lsp/transport`, `settings/schema`, `commands/registry`+`builtins` | Fast, zero-flake base |
| **L2 Store** | jsdom | all 8 zustand stores + cross-store (sessions↔layout, blocks, settings persistence) | `window.pine` mocked |
| **L3 Component** | jsdom + testing-library | `Pane`, `CommandPalette`, `SettingsPanel`, `FilesView`, `StatusStrip`/`UsageMeter`, `Terminal` (mount/attach *wiring* only) | xterm/Monaco mocked |
| **L4 E2E** | Playwright-Electron | boot → spawn terminal + run a command → split/close pane → open a file in the editor → command palette | Against **built** `out/main/index.js` |
| **SEC** | node | `fs:read`/`fs:write`/`fs:list` path-traversal | **RED now** (regression tripwire) |

**Why mock xterm & Monaco at L3?** Both need real canvas/layout/Web Workers and misbehave under
jsdom (FitAddon on a 0×0 host computes bad dims; Monaco's `?worker` Vite imports don't resolve in
Vitest). At L3 we assert *wiring* — `pty.attach` called with the right paneId, resize forwarded,
subscriptions disposed on unmount — and cover real rendering at **L4** only. This is the standard
Electron split and matches the code's own hazards (see `docs/ARCHITECTURE.md` and the "dragons"
list in §8).

---

## 4. Tooling & configuration (files to create)

### 4.1 `vitest.workspace.ts` (new) + `vitest.config.ts` (keep as base)

```ts
// vitest.workspace.ts — Vitest 2 multi-env. Collapses to test.projects on Vitest 3.
import { defineWorkspace } from 'vitest/config'

export default defineWorkspace([
  {
    // main-process + framework-free pure logic (layout tree)
    extends: './vitest.config.ts',
    test: {
      name: 'node',
      environment: 'node',
      include: [
        'src/main/**/*.test.ts',
        'src/shared/**/*.test.ts',
        'src/renderer/layout/**/*.test.ts',
      ],
    },
  },
  {
    // renderer: stores + components (DOM / window.pine)
    test: {
      name: 'dom',
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./test/setup.ts'],
      include: ['src/renderer/**/*.test.{ts,tsx}'],
      exclude: ['src/renderer/layout/**'],
      alias: { '@': '/src/renderer', '@shared': '/src/shared' },
    },
  },
  {
    // security regression suite — a SEPARATE project so default `pnpm test`
    // (node+dom) stays green; RED tests live here and run via `pnpm test:security`.
    test: {
      name: 'security',
      environment: 'node',
      include: ['test/security/**/*.test.ts'],
    },
  },
])
```

**Project selection is how we keep CI green while security is red.** `pnpm test` explicitly
selects `--project node --project dom` (skips `security`); `pnpm test:security` selects
`--project security`. A bare `vitest run` (no flag) runs all three and will show the security reds —
that's fine and intentional.

Coverage lives on the base `vitest.config.ts` via `@vitest/coverage-v8`
(reporters `text` + `html` + `lcov`; `all: true`; exclude `src/renderer/components/ui/**`,
`out/**`, `**/*.test.*`, `test/**`). No thresholds enforced in this first plan (measure first).

### 4.2 `test/setup.ts` (new, jsdom project)

- `import '@testing-library/jest-dom/vitest'` (registers DOM matchers on Vitest `expect`).
- `afterEach(cleanup)` from `@testing-library/react` (unmount between tests).
- `vi.stubGlobal('pine', makePineMock())` → provides `window.pine` in jsdom.

### 4.3 `test/mocks/pine.ts` (new)

A `makePineMock(): PineBridge` factory — **typed as `PineBridge`** so the compiler flags drift when
the bridge contract changes (the mock is the contract's test double). Every method is a `vi.fn()`
with a sensible default resolve; the three subscription methods (`pty.onData`, `pty.onExit`,
`window.onMaximizeChange`, `lsp.onMessage`, `lsp.onExit`) return an unsubscribe `() => {}` because
components call it during cleanup. Per-test overrides via
`vi.mocked(window.pine.fs.read).mockResolvedValueOnce(...)`.

### 4.4 `test/mocks/xterm.ts`, `test/mocks/monaco.ts` (new)

Reusable `vi.mock` factories for the terminal/editor modules and their `?worker` / CSS imports, so
L3 component tests that transitively import them don't blow up in jsdom.

### 4.5 Playwright: `playwright.config.ts` + `e2e/` (new)

- `testDir: 'e2e'`, `use: { trace: 'on-first-retry', screenshot: 'only-on-failure', video: 'retain-on-failure' }`.
- Tests launch the **built** app: `_electron.launch({ args: ['out/main/index.js'], env: { ...process.env, NODE_ENV: 'test' } })`, then `app.firstWindow()`.
- **Gate:** E2E requires `pnpm build` **and** `pnpm rebuild` (node-pty must match the current
  Electron ABI or every terminal shows the "node-pty unavailable" banner). Documented in the E2E
  README + `CLAUDE.md`.

### 4.6 `package.json` scripts (append) + devDeps (pnpm)

```jsonc
"test":          "vitest run --project node --project dom",   // green suite (excludes security)
"test:watch":    "vitest --project node --project dom",
"test:coverage": "vitest run --project node --project dom --coverage",
"test:unit":     "vitest run --project node",
"test:security": "vitest run --project security",             // currently RED (known fs gap)
"test:e2e":      "playwright test"
```

devDeps (via `pnpm add -D`): `jsdom`, `@testing-library/react`, `@testing-library/dom`,
`@testing-library/jest-dom`, `@testing-library/user-event`, `@vitest/coverage-v8`,
`@playwright/test`.

---

## 5. Security regression suite (the one open call, now decided)

The `fs:read` / `fs:write` / `fs:list` IPC handlers in `src/main/index.ts` (lines 307–333) run user
paths through `expandHome()` with **no traversal guard** — they can read `/etc/passwd`, write to
`/etc/cron.d/`, or escape via `../../`. We write **failing tests now** as a regression tripwire.

**CI-color handling (decided):** the `security` project (§4.1) is **excluded from the default
`pnpm test`** and run via `pnpm test:security`. This keeps the main suite green while the vuln is
visibly RED in its own command; when `main` gains a guard, the tests flip to green. (Rejected
alternative: `test.fails()` tripwire — green while vulnerable, which inverts the "fails today"
mental model.)

**Testability approach:** the handler bodies are closures over `ipcMain`. The plan extracts them
into exported pure functions — `fsRead(path, roots)`, `fsWrite(path, content, roots)`,
`fsList(dir, roots)` (and the guard they share, `resolveSafe(path, roots)`) — that the `ipcMain`
handlers then call. This is a **minimal, explicitly called-out edit** to `src/main/index.ts`; it
changes no runtime behavior yet (the extracted functions are today's unguarded logic), so the RED
test exercises the *real* current code path. The actual fix (adding the guard inside
`resolveSafe`) is a later task owned by `main`, and it flips these tests green. Fallback if the edit
is rejected: assert the vulnerable behavior at the IPC boundary in an E2E test instead.

**Test framing — never touch real system dirs.** Tests create a scratch tmpdir
(`fs.mkdtempSync`) and treat it as the single **allowed root**. They then attempt escapes and
assert they're blocked (fail today):
- `fsRead(root + '/../../../etc/passwd', [root])` → expect `null` (today: returns contents → RED).
- `fsRead('/etc/passwd', [root])` (absolute, outside root) → expect `null`.
- `fsWrite(root + '/../escape.txt', 'x', [root])` → expect `false` **and** assert no file was
  created at the escaped path (a sibling of the scratch dir, cleaned in `afterEach`) — **never**
  `/etc`, so an EACCES can't produce a false pass.
- `fsList(root + '/../..', [root])` → expect `[]` (no directory listing outside root).
- Positive controls (must pass even today): in-root read/write/list succeed; `~`→home expansion
  still resolves for a path that stays within an allowed root.
The scratch dir and any escaped sibling are removed in `afterEach`.

---

## 6. Test conventions (all suites)

- **Determinism:** capture each store's pristine state once, `setState(init, true)` (replace, not
  merge) in `afterEach`; reset id counters (`tree` already exports `resetIds()`). Reset **every**
  cross-referenced store (sessions↔layout↔settings) or a later test inherits earlier state.
- **No real network / no real user fs** in L1–L3. Security + any fs tests use a scratch dir under
  the OS tmpdir, cleaned in `afterEach`.
- **Co-location:** unit/component tests as `*.test.ts(x)` beside source (matches `tree.test.ts`);
  E2E in `e2e/*.spec.ts`; shared setup/mocks in `test/`.
- **Naming:** `describe(unitUnderTest)`, `it('does X when Y')`.

---

## 7. Phasing (this first plan delivers all of it, sequenced; each phase verified green
except the intentional SEC reds)

- **P0 — Wiring.** pnpm devDeps; `vitest.workspace.ts`; `test/setup.ts`; `test/mocks/*`; coverage
  on base config; `package.json` scripts; `playwright.config.ts` + `e2e/` skeleton. **Author root
  `CLAUDE.md`** from §8. Gate: `pnpm test` runs (green, still just the tree test) + `pnpm typecheck`
  + `pnpm lint` clean.
- **P1 — L1 unit.** `shellIntegration` (zsh ZDOTDIR env, bash `--rcfile`, fish/unknown no-op),
  `lsp/transport` (reader/writer over a mocked `window.pine.lsp`), `settings/schema` (validate /
  defaults / merge), `commands/registry`+`builtins`, and extend `tree`.
- **P2 — L2 stores.** All 8 stores + the sessions↔layout↔settings cross-store invariants (never
  zero sessions; `closePane` never removes the last pane; workDir anchor vs pane cwd; settings
  debounced persist calls `fs.write`).
- **P3 — L3 components.** `Pane`, `CommandPalette`, `SettingsPanel`, `FilesView`,
  `StatusStrip`/`UsageMeter`, and `Terminal` wiring — with xterm/Monaco mocked. Assert behavior +
  a11y (roles/labels), not pixels.
- **P4 — SEC.** Extract the guard helper; write the RED `test/security/fs-traversal.test.ts`.
- **P5 — E2E.** `pnpm build` + `pnpm rebuild`, then Playwright smoke: boot, spawn terminal + run
  `echo`, split & close a pane, open a file in the editor, open the command palette.

Order rationale: base → pure → state → UI → security → real app. Earlier phases de-risk later ones
(a broken store fails fast at L2, not deep in an E2E trace).

---

## 8. `CLAUDE.md` outline (root, new — shared onboarding for all agents)

Authored in P0 from the research pass. Sections:

1. **What this is** — one paragraph (Warp-like terminal + VSCode-like IDE + agent host; codename
   `pine`; MVP = M1).
2. **Commands & when to run them** — `pnpm dev` / `build` / `preview` / `typecheck` (two tsc
   passes) / `rebuild` (**after any Electron bump / fresh install / ABI change** — node-pty is
   native; missing → terminals silently disable) / `lint` / `format` / `test` / `test:e2e`.
   **pnpm is the package manager.**
3. **Architecture** — three processes (main privileged / preload = the single typed `window.pine`
   bridge / renderer = no Node access) + `shared/types.ts` as the IPC contract. Security baseline
   (`contextIsolation`, `sandbox`, `nodeIntegration: false`).
4. **Invariants you must not break** — renderer has zero Node access (new capability = add to
   `PineBridge` → main handler → thin preload forwarder); pty lives in **main**, keyed by pane id,
   with buffer replay + 3s detach grace; shell-integration OSC 133/OSC 7 marks are the block/cwd
   source of truth (only zsh/bash integrated, others degrade gracefully); never touch the user's
   real dotfiles (generated ZDOTDIR / `--rcfile`); `pine` codename is one constant; layout `tree.ts`
   transforms are pure/immutable; never leave zero sessions / never remove the last pane.
5. **Conventions** — Biome (2-space, single quotes, no-semi), TS strict + `_`-prefixed unused,
   path aliases, high JSDoc density, zustand patterns (`getState()` across stores, hook selectors
   inside React), Session→Panes→Surface model.
6. **Dragons** — `BASH_B_MARK` escaping; bash preexec false-positive gate; pty buffer trim
   boundary; `pty:attach` subscribe-before-attach race; `safeFit` never on 0×0; debounced resize;
   OSC 7 not percent-decoded; node-pty loaded lazily & tolerated absent; tear-off trusts OS cursor.
7. **How we test** — the pyramid from this doc: `pnpm test` (unit+component), `pnpm test:e2e`
   (needs build + rebuild), `pnpm test:security` (currently RED — known fs-traversal gap). Where to
   put a new test (pure→node, DOM→jsdom, xterm/Monaco/real-pty→E2E). Reset stores between tests.
8. **Known gaps** — fs path-traversal (SEC suite is red until guarded).

---

## 9. Deliverables checklist

- [ ] `vitest.workspace.ts`, coverage on `vitest.config.ts`
- [ ] `test/setup.ts`, `test/mocks/pine.ts`, `test/mocks/xterm.ts`, `test/mocks/monaco.ts`
- [ ] `playwright.config.ts`, `e2e/` (config + smoke specs + a short README on the build+rebuild gate)
- [ ] `package.json` scripts + pnpm devDeps
- [ ] L1 unit suites (shellIntegration, transport, settings schema, commands, tree-extended)
- [ ] L2 store suites (8 stores + cross-store)
- [ ] L3 component suites (Pane, CommandPalette, SettingsPanel, FilesView, StatusStrip/UsageMeter, Terminal-wiring)
- [ ] SEC suite (fs-traversal, RED) + extracted guard helper
- [ ] E2E smoke suite
- [ ] root `CLAUDE.md`
