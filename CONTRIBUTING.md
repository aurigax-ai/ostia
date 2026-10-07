# Contributing to Ostia

Conventions for people and coding agents (Claude Code, Codex) working in this repo. Claude Code users: add `@CONTRIBUTING.md` to your local `CLAUDE.md` (it is not tracked) so your agent reads this file. Codex reads it through `AGENTS.md`.

## Workflow

1. **Open an issue first.** One problem per issue, in English: what is wrong, what is expected, and a "Done when" line. Label it (see below) and set the milestone.
2. **Branch from the latest `main`**: `<type>/<short-description>`, where type is `fix`, `feat`, `docs`, `refactor`, `test` or `ci`. `main` is protected: every change, admins included, goes through a pull request, and force pushes and branch deletion are blocked.
3. **Commit** with [Conventional Commits](https://www.conventionalcommits.org/) in English (`fix(terminal): …`, `feat(browser): …`). No code comments: `scripts/comments.mjs` rejects them.
4. **Check before pushing**:
    - `pnpm typecheck`, `pnpm lint` and `pnpm exec vitest related <changed files> --run`. CI runs unit tests on every PR (the tests your diff affects, or all of them; see CI below) and e2e on release candidates and every night.
    - when a change needs e2e evidence, run only the specs you touched on CI: `gh workflow run ci.yml --ref <branch> -f full=true -f specs=e2e/<spec>.ts` (see CI below)
    - macOS-only behaviour (menus, Cmd keys) on a real Mac. For a bug fix, revert only the code, keep the new test, and confirm the test fails.
    - scan the whole branch for secrets (tokens, keys, certificates); nothing may match
5. **Open a PR.** First line of the description: `Closes #N` (one line per issue). Then why, what changed, how it was tested, and what is not verified yet. Same labels and milestone as the issue. Check the link with `gh pr view <N> --json closingIssuesReferences`.
6. **Merge** only when CI is green and a maintainer says so, by adding the PR to the merge queue. Agents never merge or approve on their own. Use a merge commit (no squash) and delete the branch. If two PRs conflict, the author of the later one merges `main` into their branch; no force pushes.
7. **Release**: bump `package.json` in a pull request, then tag `v*` on `main` (a `-rc.N` tag cuts a pre-release). The tag runs the full CI, e2e included, and the macOS signing job waits for a maintainer to approve the `release-macos` environment.

## Supported platforms

macOS and Arch-based Linux (CachyOS) come first. Debian and Ubuntu are supported too, but a bug there ranks below the same bug on those two.

## Labels

The labels (name, colour, description) are defined in `.github/labels.yml`; change that file and the repository labels together.

Every issue and PR gets **one `type:`**, **one or two `area:`**, a **`platform:`** only when it is platform-specific, and (issues only) **one priority**.

- `type:` `bug`, `feature`, `enhancement`, `docs`, `refactor`, `test`, `ci`
- `area:` `terminal`, `agents`, `extensions`, `sandbox`, `settings`, `keybindings`, `ui`, `browser`, `editor`, `remote`, `cli`, `release`
- `platform:` `macOS`, `Linux` (Windows is not supported; use `wontfix`)
- Priority: `P0` crash, data loss or security · `P1` blocks daily use · `P2` normal · `P3` nice to have
- `status: needs triage`, `status: needs decision`, `status: blocked` when they apply; progress is shown by linked PRs, not labels
- `agent: ready`: the issue has a clear spec and "Done when", so an agent can pick it up as is

## Milestones

One milestone per minor version, named `v<major>.<minor>: <theme>` in English, e.g. `v0.5: Stable daily driver`. Patch releases (0.5.7, 0.5.8) stay under their minor's milestone; releases themselves are git tags and GitHub Releases. A milestone whose theme is not decided yet is called `Next milestone`.

Every issue and PR gets the milestone of the release line it lands in. Open milestones: `v0.5: Stable daily driver` (current release line), `v0.6: Bug fixes`, `v0.7: Next milestone`.

## CI

- Pull requests and pushes to `main` run static checks, Linux unit tests and builds; the macOS unit tests (`unit-macos`) run on pushes to `main`, tags, the nightly run and manual runs, not on pull requests. A pull request runs only the unit tests its diff against the merge-base can affect (`scripts/affectedTests.mjs`): `vitest related` over the changed files, every node test once a change reaches code outside `src/renderer` (the CLI, extensions and SDK built for the tests bundle it), and the dom tests that read files at run time. A change outside `src/` and `e2e/` (lockfile, `package.json`, configs, `test/`, `scripts/`, `.github/`), other than a root `*.md`, runs every test, as do pushes to `main`, the nightly run and tags. The e2e suites (Linux and macOS) run for `v*` tags, every night on `main`, and on demand: `gh workflow run ci.yml --ref <branch> -f full=true`, or Actions → CI → Run workflow.
- A manual run can be narrowed with three inputs. `platform` is `all` (default), `linux` or `macos`: `linux` starts no macOS job, `macos` starts no Linux e2e job (static, unit and build still run on Linux). `specs` is a space-separated list of e2e files or patterns; when set, Linux runs one e2e job instead of four shards and macOS runs one job instead of four groups. `repeat` is passed to Playwright as `--repeat-each`. The inputs only apply when `full` is true. Examples:
    - `gh workflow run ci.yml --ref <branch> -f platform=linux -f specs=e2e/system.spec.ts -f repeat=3`
    - `gh workflow run ci.yml --ref <branch> -f platform=macos -f specs="e2e/ssh.spec.ts e2e/ssh-remote-files.spec.ts"`
- `changes` and `unit` always run on GitHub-hosted `ubuntu-24.04` (unit needs sudo for apt and an AppArmor sysctl). For maintainer pushes and PRs, the Linux jobs run on self-hosted ARC runners on Kubernetes, sized per job: `static`, `unit-dom`, `build` and the Linux e2e shards on `ostia-linux` (4 CPU / 8 Gi), and `ci-result` and `e2e-report`, which do seconds of work, on `ostia-linux-small` (2 CPU / 4 Gi). `unit-macos` runs on a self-hosted Mac. Fork PRs run on GitHub-hosted runners only.
- Pull requests merge through the merge queue once the fast checks are green (static, Linux unit, build, `ci-result`). The queue merges `main` with the queued pull requests ahead of it and runs the same jobs on that commit (`merge_group`, on GitHub-hosted runners, without `unit-macos` and `quarantine`), so two pull requests that pass alone but break `main` together are caught before they land. Pushes to `main` run one at a time: a push that arrives while one is running waits, and a newer push replaces the waiting one. `unit-macos` does not run on a PR and e2e does not block one; both run in full on `-rc.N` tags and nightly, and `unit-macos` also runs on pushes to `main`. `ci-result` does not include the macOS jobs, so read them separately. `quarantine` does not run on pull requests or in the queue: it runs 10 times on Linux and macOS in the nightly and manual runs, and 5 times on Linux only on pushes to `main` and tags.
- Ask Justin before changing `.github/workflows/ci.yml`, `.github/workflows/release.yml` or `.github/actions/setup/action.yml`; the self-hosted runners depend on them.
- Every job has `timeout-minutes` (about 3× its measured time, at least 10 minutes for a job that downloads packages), and the setup action and test steps have step timeouts. A new job gets one too.
- Every `apt-get` and the setup action's `pnpm install` run through `scripts/retry.sh` (4 attempts, 10/20/40 s back-off). Never retry tests: a flaky test goes into `test/quarantine.json`.
- Tests that need ptrace or `process_vm_readv` fail on the self-hosted Linux runners. Run them on GitHub-hosted Ubuntu, like `PTRACE_E2E` in `ci.yml`.
- Repo variables `OSTIA_SELF_HOSTED_LINUX` and `OSTIA_SELF_HOSTED_MACOS` set to `off` send those jobs back to GitHub-hosted runners (`ubuntu-24.04`, `macos-26`). Changing them needs a maintainer. Only `OSTIA_SELF_HOSTED_MACOS` is set to `off` today, so macOS jobs run on GitHub-hosted runners.
