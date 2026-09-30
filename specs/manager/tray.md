# Manager: tray

Status: cases approved 2026-09-30 at f0f791d (the user said to start building)

## Decisions
- **MGR-D5** Close-to-tray is a setting, `workspaces.closeToTray` (next to `confirmQuit`), off by default. With it on, closing the window hides it instead of quitting; the tray icon shows only while Pine is hidden, and its menu has Show and Quit. Quit shows the window first so `closeGuard` can ask about running commands. A Pine started hidden by `pine <agent>` behaves as if it were on. Why: normal launches keep today's behaviour, and a Linux desktop may have no tray host. Governs: window close, `workspaces.closeToTray`, tray menu.
- **MGR-D6** While a manager is live, closing the window hides Pine to the tray even if close-to-tray is off. Why: quitting would kill the agent the human is talking to from outside. Governs: window close while a manager is live. Unexpected: n/a — it only turns a close into a hide; quitting from the tray still goes through `closeGuard` (MGR-C4).

## Cases
| ID | Covers | Kind | Case |
|---|---|---|---|
| MGR-C19 | MGR-D6 | expected | Given a manager is live and close-to-tray is off, when the window is closed, then Pine hides to the tray |
| MGR-C1 | MGR-D5 | expected | Given `workspaces.closeToTray` on, when the window is closed, then it hides, Pine keeps running with its ptys alive, and the tray icon appears |
| MGR-C2 | MGR-D5 | expected | Given `workspaces.closeToTray` off (the default), when the window is closed, then Pine quits as before, after `closeGuard` |
| MGR-C3 | MGR-D5 | expected | Given Pine hidden in the tray, when Show is picked, then the window shows and the tray icon goes away |
| MGR-C4 | MGR-D5 | expected | Given Pine hidden in the tray, when Quit is picked, then the window shows and quitting goes through `closeGuard` |
| MGR-C5 | MGR-D5 | unexpected | Given a settings.json that is missing, unreadable or holds a non-boolean `closeToTray`, when the window is closed, then it is treated as off |
| MGR-C6 | MGR-D5 | unexpected | Given `workspaces.closeToTray` on, when a quit was already approved, then windows close instead of hiding |

## Open
- A second launch while Pine is hidden starts a second instance. A single-instance lock would stop `pnpm dev` while the installed Pine runs (they share `userData`). Does the portal's instance file (portal segment) replace the lock?
