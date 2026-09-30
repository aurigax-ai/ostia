# Sandbox: filesystem

Status: cases approved 2026-09-30 at 8457e4a

Intent: a sandboxed shell reads only the workspace folder, the paths the human allows and the
system, and writes only the workspace folder, a private tmp and the agent CLIs' session data.
Back to [the index](index.md).

## Decisions
- **SBX-D7** Reads: all of the home directory is denied, except the `workDir`, the global
  `sandbox.allowRead` list (seeded with shell rc files and toolchain folders: `~/.zshrc`,
  `~/.zshenv`, `~/.bashrc`, `~/.p10k.zsh`, `~/.oh-my-zsh`, `~/.cargo`, `~/.rustup`,
  `~/.local/bin`, `~/.nvm`), the workspace's own `allowRead`, and the paths Pine needs (shell
  integration dir, the pane's shell state file, the app path, the control socket). Pine's data dir
  (userData, including the vault) is always denied, even if listed. System paths outside home
  stay readable. Why: the human chose strict, with a way to open more. Governs: srt
  filesystem.denyRead, srt filesystem.allowRead, settings.json#sandbox.allowRead.
- **SBX-D8** Only the human adds read paths, in the workspace's Sandbox view or Settings → Sandbox.
  There is no agent verb for it. A change applies to shells spawned afterwards (the pane shows
  "Restart to apply"). A path must be absolute (or start with `~`) and must exist; `/`, the whole
  home directory and Pine's data dir are refused. Why: srt fixes filesystem rules at wrap time,
  and widening reads is the human's call. Governs: sandbox:set-allow-read IPC.
- **SBX-D9** Writes: only the `workDir` and a private per-workspace tmp dir (`TMPDIR` points to
  it) are writable, plus the agent CLIs' data folders (`~/.claude`, `~/.codex`). Inside those
  folders, the files that run code or instruct agents outside the sandbox are write-denied:
  `settings.json`, `settings.local.json`, `hooks`, `plugins`, `CLAUDE.md`, `config.toml`,
  `AGENTS.md`. Why: sessions and logs must work, but a sandboxed agent must not plant a hook that
  later runs unsandboxed. Governs: srt filesystem.allowWrite, srt filesystem.denyWrite.
- **SBX-D10** Files in the `workDir` that the host executes are write-denied: `.git/hooks`,
  `.git/config` and `.envrc`. A repo created inside the sandbox (`git init`) is protected
  from that shell's next spawn on, not before. Why: Pine's git extension and the human's own
  shells run git hooks, `core.fsmonitor` and direnv outside the sandbox. Governs: srt
  filesystem.denyWrite for workDir.
- **SBX-D11** The sandbox mounts the real `workDir`, not a copy. The host (the human's editor, other
  workspaces, the git extension) and the sandbox see each other's writes immediately; the last
  writer wins, the same as without a sandbox, and the editor's existing on-disk-change handling
  applies. There is nothing to merge. Why: no snapshots or overlays were asked for, and a shared
  folder has no divergence. Governs: workDir mount.

- **SBX-D22** Host-executed and Pine-owned files in the `workDir` are protected by srt's own
  mandatory write-deny list (shell rc files, `.gitconfig`, `.gitmodules`, `.git/hooks`,
  `.git/config`, `.vscode`, `.idea`, `.mcp.json`, `.claude/commands`, `.claude/agents`), which also
  covers paths that don't exist yet, plus Pine's own additions: `.envrc` write-denied, and
  `.pine/vault.json` read- and write-denied. Why: srt already guards the host-executed files,
  including ones a later `git init` creates, and the project vault must not be readable or
  corruptible from inside. Governs: srt filesystem.denyWrite for workDir. Supersedes: SBX-D10.

- **SBX-D37** The sandbox mounts the real `workDir`, not a copy. The host (the human's editor, other
  workspaces, the git extension) and the sandbox write the same files; the last writer wins, the
  same as without a sandbox, and there is nothing to merge. Showing on-disk changes in an open
  editor is the editor's own feature, specced separately. Why: SBX-D11 assumed the editor already
  reloads changed files, and it doesn't. Governs: workDir mount. Supersedes: SBX-D11.

## Cases
| ID | Covers | Kind | Case |
|---|---|---|---|
| SBX-C21 | SBX-D7 | expected | Given a sandboxed pane, when it reads a file in the workDir and `~/.zshrc`, then both succeed, and the prompt and shell integration (blocks, cwd) work |
| SBX-C22 | SBX-D7 | expected | Given a sandboxed pane, when it reads `~/.ssh/config` or another project's folder under home, then it gets permission denied |
| SBX-C23 | SBX-D7 | unexpected | Given the human lists Pine's data dir in `sandbox.allowRead`, when a sandboxed pane reads the vault file, then it is still denied |
| SBX-C24 | SBX-D7 | expected | Given a sandboxed pane, when it runs `pine whoami`, then the CLI reaches the control socket and answers |
| SBX-C25 | SBX-D8 | expected | Given the human adds `~/notes` to a workspace's read paths, when that pane's shell restarts, then `ls ~/notes` works in it and not in other sandboxed workspaces |
| SBX-C26 | SBX-D8 | unexpected | Given the Sandbox view, when the human enters `/`, `~`, Pine's data dir, a relative path or a path that doesn't exist, then it is refused with a reason and nothing is stored |
| SBX-C27 | SBX-D8 | unexpected | Given an agent in a sandboxed pane, when it tries every `pine` verb or settings key that could add a read path, then none exists or each is refused |
| SBX-C28 | SBX-D9 | expected | Given a sandboxed pane, when it writes in the workDir and in `$TMPDIR`, then both succeed, and `/tmp/x` outside its private tmp and `~/x` are denied |
| SBX-C29 | SBX-D9 | expected | Given Claude Code running in a sandboxed pane, when it saves a session, then the write under `~/.claude` succeeds |
| SBX-C30 | SBX-D9 | unexpected | Given a sandboxed pane, when it writes `~/.claude/settings.json`, `~/.claude/hooks/x` or `~/.codex/config.toml`, then each is denied |
| SBX-C31 | SBX-D22 | expected | Given a sandboxed pane in a git repo, when it commits, then the commit succeeds, and writing `.git/hooks/pre-commit`, `.git/config` or `.envrc` is denied |
| SBX-C32 | SBX-D22 | unexpected | Given a workDir that isn't a repo, when the sandboxed shell runs `git init`, then writing `.git/hooks/pre-commit` is denied right away |
| SBX-C62 | SBX-D22 | unexpected | Given a workspace with a project vault, when its sandboxed shell reads, deletes or overwrites `.pine/vault.json`, then each is denied, and the vault still works from the host |
| SBX-C34 | SBX-D37 | unexpected | Given the human and a sandboxed agent write the same file at nearly the same time, when both writes land, then the file holds the last write, with no error and no copy left behind |

## Open
