# Contributing to Ostia

Conventions for people and coding agents (Claude Code, Codex) working in this repo. Claude Code users: add `@CONTRIBUTING.md` to your local `CLAUDE.md` (it is not tracked) so your agent reads this file. Codex reads it through `AGENTS.md`.

## Workflow

1. **Open an issue first.** One problem per issue, in English: what is wrong, what is expected, and a "Done when" line. Label it (see below) and set the milestone.
2. **Branch from the latest `main`**: `<type>/<short-description>`, where type is `fix`, `feat`, `docs`, `refactor`, `test` or `ci`. `main` is protected: every change, admins included, goes through a pull request, and force pushes and branch deletion are blocked.
3. **Commit** with [Conventional Commits](https://www.conventionalcommits.org/) in English (`fix(terminal): …`, `feat(browser): …`). No code comments: `scripts/comments.mjs` rejects them.
4. **Check before pushing**:
    - `pnpm typecheck`, `pnpm lint`, `pnpm test`
    - the e2e specs for what you touched (`pnpm test:e2e e2e/<spec>.ts`); PR CI does not run e2e, so this is the only e2e check a change gets before the nightly run
    - macOS-only behaviour (menus, Cmd keys) on a real Mac. For a bug fix, revert only the code, keep the new test, and confirm the test fails.
    - scan the whole branch for secrets (tokens, keys, certificates); nothing may match
5. **Open a PR.** First line of the description: `Closes #N` (one line per issue). Then why, what changed, how it was tested, and what is not verified yet. Same labels and milestone as the issue. Check the link with `gh pr view <N> --json closingIssuesReferences`.
6. **Merge** only when CI is green and a maintainer says so. Agents never merge or approve on their own. Use a merge commit (no squash) and delete the branch. If two PRs conflict, the author of the later one merges `main` into their branch; no force pushes.
7. **Release**: bump `package.json` in a pull request, then tag `v*` on `main` (a `-rc.N` tag cuts a pre-release). The tag runs the full CI, e2e included, and the macOS signing job waits for a maintainer to approve the `release-macos` environment.

## Labels

Every issue and PR gets **one `type:`**, **one or two `area:`**, a **`platform:`** only when it is platform-specific, and (issues only) **one priority**.

- `type:` `bug`, `feature`, `enhancement`, `docs`, `refactor`, `test`, `ci`
- `area:` `terminal`, `agents`, `extensions`, `sandbox`, `settings`, `keybindings`, `ui`, `browser`, `editor`, `remote`, `cli`, `release`
- `platform:` `macOS`, `Linux` (Windows is not supported; use `wontfix`)
- Priority: `P0` crash, data loss or security · `P1` blocks daily use · `P2` normal · `P3` nice to have
- `status: needs triage`, `status: needs decision`, `status: blocked` when they apply; progress is shown by linked PRs, not labels
- `agent: ready`: the issue has a clear spec and "Done when", so an agent can pick it up as is

## Milestones

Theme milestones, not version numbers (versions are git tags and GitHub Releases): `macOS daily driver`, `Rename to Ostiaterm, phase 2`, `Self-hosted CI`.

## CI

- Pull requests and pushes to `main` run static checks, unit tests (Linux and macOS) and builds. The e2e suites (Linux and macOS) run for `v*` tags, every night on `main`, and on demand: `gh workflow run ci.yml --ref <branch> -f full=true`, or Actions → CI → Run workflow.
- Maintainer pushes and PRs run on self-hosted runners (Linux and `unit-macos`); fork PRs run on GitHub-hosted runners only.
- Ask Justin before changing `.github/workflows/ci.yml`, `.github/workflows/release.yml` or `.github/actions/setup/action.yml`; the self-hosted runners depend on them.
- Tests that need ptrace or `process_vm_readv` fail on the self-hosted Linux runners. Run them on GitHub-hosted Ubuntu, like `PTRACE_E2E` in `ci.yml`.
- Repo variables `OSTIA_SELF_HOSTED_LINUX` and `OSTIA_SELF_HOSTED_MACOS` set to `off` send those jobs back to GitHub-hosted runners. Changing them needs a maintainer.
