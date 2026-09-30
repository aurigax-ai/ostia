# Sandbox: secrets

Status: cases approved 2026-09-30 at 8457e4a

Intent: a sandboxed agent gets the real secrets it needs (tokens, SSH keys) only when the human
grants them, in one of three ways: an env var, a file, or a value handed over on request after a
prompt. Saved browser logins are not part of it. Host secrets stay the host's: Pine lists and hands them over, and never edits or copies
them. Back to [the index](index.md).

## Decisions
- **SBX-D25** The secret service lists two kinds of secret. **Host** secrets are private keys in
  `~/.ssh`, variables in Pine's own environment whose names end in `_TOKEN`, `_KEY`, `_SECRET` or
  `_PASSWORD`, and `gh auth token`. They're read-only in Pine (no edit, rename or delete), their
  values are read at the moment of use, and they're never copied into a Pine store. **Pine**
  secrets are the existing vault's (global and project), editable in the UI. Both show in the
  workspace's Secrets tab and in Settings › Sandbox, labelled Host or Pine. Why: the human wants
  host secrets usable but untouchable, and Pine-created ones manageable. Governs: secret sources,
  Secrets tab list.
- **SBX-D26** The human grants a secret to a workspace with one injection way. **env** sets a
  variable (the name the human picks, default the secret's name) in shells spawned afterwards.
  **file** writes the value to `$PINE_SECRETS_DIR/<name>` with mode 0600. That's a per-workspace
  directory in `privateTmpDir`, readable inside the sandbox and removed when the workspace closes
  or the app quits. For an SSH key, Pine also sets `GIT_SSH_COMMAND` to use that key through the
  sandbox's SOCKS proxy. **request** injects nothing; the agent must ask (SBX-D27). The values
  are real, not masked. A change applies to shells spawned afterwards ("Restart to apply"). Why:
  the human chose real values because agents must use them, and masking breaks tools. Governs:
  secret grants, secret injection, PINE_SECRETS_DIR.
- **SBX-D27** `pine secret ls` returns the name and label (Host or Pine) of every secret, never
  a value. `pine secret get <name> [--reason <text>]` raises a card showing the secret, the
  workspace and the reason: Allow once, Allow until restart, or Deny. On allow, the value is
  printed to stdout; on deny or timeout, it exits non-zero. It always asks, even in
  `approvals.mode: 'allow'`, unless the secret is granted to that workspace (any way), and values
  never appear in approval history, logs or events. Why: the human asked for list, ask, then
  allow-gives-the-secret or deny. Governs: pine secret ls, pine secret get, secret.* socket
  methods.
- **SBX-D28** In a sandboxed workspace, `pine vault get` is refused with a hint to use
  `pine secret get`, so a vault value always goes through a grant or a card. `vault.set`,
  `vault.list` and `vault.delete` keep their capability rules. Why: `vault get` would hand over
  plaintext with no prompt, which bypasses SBX-D27. Governs: vault.get in sandboxed workspaces.

- **SBX-D32** Pine's saved browser passwords (`main/credentials.ts`) are a third kind of secret,
  labelled **Browser**, listed by origin and username only. The agent never receives the password:
  `pine secret fill <origin> [--reason <text>]` raises a card (origin, username, the pane's current
  page and the reason: Allow once, Allow until restart, or Deny), and on allow main fills the login
  form in that pane's workspace browser pane, exactly as the human's own fill does. Only a page
  whose origin matches the saved origin exactly is filled. `pine secret get` on a Browser secret
  is refused, and Browser secrets can't be granted as env or file. Why: the human wants browser
  secrets from the secret service, and Pine's rule is that no socket method or CLI verb returns a
  password; filling happens in main. Governs: pine secret fill, Browser secrets, credentials
  fill from the socket.

- **SBX-D35** The human grants a secret to a workspace with one injection way. **env** sets a
  variable (the name the human picks, default the secret's name) in shells spawned afterwards.
  **file** writes the value to `$PINE_SECRETS_DIR/<name>` with mode 0600, in the workspace's private
  tmp folder, which other sandboxes can't read and which is removed when the workspace closes or
  the app quits. A file-granted SSH key also reaches git through a per-workspace `ssh-agent` that
  Pine runs outside the sandbox, loaded with only the granted keys; its socket sits in that
  private folder and becomes the sandbox's `SSH_AUTH_SOCK`, while srt's own `GIT_SSH_COMMAND`
  carries the proxy. **request** injects nothing; the agent must ask (SBX-D27). Values are real,
  not masked, and a change applies to shells spawned afterwards ("Restart to apply"). Why: srt
  sets `GIT_SSH_COMMAND` itself and overrode the `-i` flag SBX-D26 relied on; everything else is
  unchanged. Governs: secret grants, secret injection, PINE_SECRETS_DIR. Supersedes: SBX-D26.

- **SBX-D36** The secret service holds Host and Pine secrets only. Saved browser logins stay with
  the browser: the secret service doesn't list, fill or hand them over, and agents sign in with
  `pine browse login`, which asks through the `credentials` capability. Why: the human decided the
  two stay separate, so each has one owner and one approval path. Governs: pine secret fill,
  Browser secrets, credentials fill from the socket. Supersedes: SBX-D32.

## Cases
| ID | Covers | Kind | Case |
|---|---|---|---|
| SBX-C67 | SBX-D25 | expected | Given `~/.ssh/id_ed25519` and `GITHUB_TOKEN` in Pine's environment, when the human opens the Secrets tab, then both are listed as Host, and the Pine vault's entries are listed as Pine |
| SBX-C68 | SBX-D25 | unexpected | Given a Host secret, when the human looks for Edit, Rename or Delete, then none is offered, and no socket method or CLI verb changes it |
| SBX-C69 | SBX-D25 | unexpected | Given a Host secret granted to a workspace, when the key file is later removed from `~/.ssh`, then the next shell spawn reports it missing in the pane and the Secrets tab, and spawns without it |
| SBX-C70 | SBX-D35 | expected | Given `GITHUB_TOKEN` granted as env, when a sandboxed shell spawns, then `echo $GITHUB_TOKEN` prints the real value |
| SBX-C71 | SBX-D35 | expected | Given `~/.ssh/id_ed25519` granted as file and `github.com:22` allowed, when the sandboxed shell runs `git fetch` over SSH, then it authenticates with that key, and `~/.ssh` itself is still unreadable |
| SBX-C72 | SBX-D35 | unexpected | Given a file secret, when the workspace closes or the app quits, then its `$PINE_SECRETS_DIR` directory is gone from disk |
| SBX-C73 | SBX-D35 | unexpected | Given two sandboxed workspaces, when one has a file secret, then the other's shell can't read that file |
| SBX-C74 | SBX-D27 | expected | Given a sandboxed agent, when it runs `pine secret get DB_PASSWORD --reason "run migrations"` and the human clicks Allow once, then the value is printed and a second get asks again |
| SBX-C75 | SBX-D27 | expected | Given a sandboxed agent, when it runs `pine secret ls`, then it gets names and labels only, with no values |
| SBX-C76 | SBX-D27 | unexpected | Given the human denies the card or it times out, when `pine secret get` returns, then it exits non-zero, prints no value, and approval history holds no value |
| SBX-C77 | SBX-D27 | unexpected | Given a name that doesn't exist, when the agent runs `pine secret get`, then it fails without a card |
| SBX-C100 | SBX-D36 | unexpected | Given saved browser logins, when an agent runs `pine secret ls` or calls `secret.fill`, then no login is listed and `secret.fill` does not exist |
| SBX-C78 | SBX-D28 | expected | Given a sandboxed workspace, when its agent runs `pine vault get KEY`, then it is refused with a hint to `pine secret get`, and `pine vault ls` still works |
| SBX-C79 | SBX-D28 | unexpected | Given an unsandboxed workspace, when its agent runs `pine vault get KEY` with `vault-read`, then it works as before |

## Open
