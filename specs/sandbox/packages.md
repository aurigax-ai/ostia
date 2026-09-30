# Sandbox: packages

Status: cases approved 2026-09-30 at 0e21cd1

Intent: a sandboxed agent installs language packages only after they pass a malware check, a
cooldown and the human's lists, and gets system packages only through the human in a host
pane. Back to [the index](index.md).

## Decisions
- **SBX-D29** A sandboxed workspace has a package firewall, on by default, for npm, pnpm, yarn,
  bun, pip, uv, cargo and Go. srt terminates TLS only for their registry hosts
  (`registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org`, `index.crates.io`,
  `static.crates.io`, `proxy.golang.org`), and a request filter parses each package download
  into ecosystem, name and version. A download is denied if the package is on the deny list,
  missing from the allow-only list (off by default), has an OSV `MAL-*` record (lookups cached;
  if OSV can't be reached the download is denied with that reason), or is younger than the
  cooldown (2 days by default). Pine also sets each package manager's own cooldown in the
  sandbox's environment, so resolvers pick older versions first. Why: this is the practice the
  research found: native cooldowns, OSV malware data, and a proxy check an agent can't skip.
  Governs: package policy, srt filterRequest, srt tlsTerminate hosts, package manager cooldown
  env.
- **SBX-D30** A denied download returns a 403 whose body gives the reason, and raises a card
  naming the package, version and reason: Allow once, Allow in this workspace, or Deny. A package
  with an OSV malware record also gets a warning on the card, and only Allow once is offered for
  it. Why: every block must be a prompt the human can answer, and a known-malicious package
  should never become a standing grant. Governs: package block card.
- **SBX-D31** System packages are never installed inside a sandbox. `pine system install` from a
  sandboxed pane keeps its card, which shows the exact command. When the human approves, it opens
  a host pane: not wrapped, marked with a Host badge, and closed when the command ends. The human
  types sudo there. The card warns that AUR (yay/paru) builds run code on the host. The agent
  skill points agents to user-space installers (mise, uv, pixi) first, and the Network tab offers
  their download hosts as a preset the human can add. Why: installing needs root and runs package
  scripts on the host, so the human must see and run it. Governs: host pane, system install from
  a sandbox, toolchain domain preset.

## Cases
| ID | Covers | Kind | Case |
|---|---|---|---|
| SBX-C80 | SBX-D29 | expected | Given default package policy, when a sandboxed shell runs `pnpm add left-pad`, then it installs (old, clean package) |
| SBX-C81 | SBX-D29 | expected | Given a package version published an hour ago, when the sandboxed shell installs exactly that version, then the download is denied with a cooldown reason |
| SBX-C82 | SBX-D29 | unexpected | Given OSV lists `evil-pkg@1.0.0` as `MAL-*`, when a sandboxed shell runs `pip install evil-pkg==1.0.0`, then the download is denied with a malware reason |
| SBX-C83 | SBX-D29 | unexpected | Given OSV can't be reached, when a sandboxed shell installs a package not in the cache, then the download is denied with an "OSV unavailable" reason, and nothing is installed |
| SBX-C84 | SBX-D30 | expected | Given a download denied for cooldown, when the human clicks Allow in this workspace on the card, then the same install succeeds on retry, and later installs of that version skip the card |
| SBX-C85 | SBX-D30 | unexpected | Given a download denied for a `MAL-*` record, when the card appears, then it shows the malware warning and offers only Allow once and Deny |
| SBX-C86 | SBX-D30 | unexpected | Given 30 downloads blocked at once in one install, when the cards appear, then they are grouped into one card listing the packages |
| SBX-C87 | SBX-D31 | expected | Given a sandboxed agent runs `pine system install jq`, when the human approves the card, then a Host-badged pane runs the command unsandboxed, the human types sudo, and the pane closes when it ends |
| SBX-C88 | SBX-D31 | unexpected | Given the human denies the card, when `pine system install` returns, then no pane opens and it exits `denied` |
| SBX-C89 | SBX-D31 | unexpected | Given a request with `--manager yay`, when the card appears, then it warns that AUR builds run code on the host |
| SBX-C90 | SBX-D31 | unexpected | Given an agent or extension, when it tries to open a host pane except through an approved system install, then it is refused, and the pane opens sandboxed |

## Open
