# Manager: tray

Status: cases approved 2026-09-30 at f0f791d (the user said to start building); MGR-D5 revised and MGR-D21, MGR-D22 added 2026-09-30 by the user ("it will never really close unless user close it; default close is minimize")

## Decisions
- **MGR-D5** Close-to-tray is a setting, `workspaces.closeToTray` (next to `confirmQuit`), on by default. With it on, closing the window hides it instead of quitting; the tray icon shows only while Pine is hidden, and its menu has Show and Quit. Quit shows the window first so `closeGuard` can ask about running commands. A Pine started hidden by `pine <agent>` behaves as if it were on. Why: the user wants Pine to keep running until they quit it; a desktop with no tray host still gets the window back by launching Pine again (MGR-D21). Governs: window close, `workspaces.closeToTray`, tray menu.
- **MGR-D6** While a manager is live, closing the window hides Pine to the tray even if close-to-tray is off. Why: quitting would kill the agent the human is talking to from outside. Governs: window close while a manager is live. Unexpected: n/a — it only turns a close into a hide; quitting from the tray still goes through `closeGuard` (MGR-C4).
- **MGR-D21** The packaged app holds a single-instance lock: a second launch exits and shows the running Pine's windows (or opens the main window if none exist); a second launch with `--hidden` shows nothing. Unpackaged runs (`pnpm dev`, E2E) take no lock, so they never block or get blocked by the installed Pine. Why: with close-to-tray on by default, launching Pine again is how the human brings it back. Governs: app start.
- **MGR-D22** The palette has a Quit command (`app.quit`) that quits through `closeGuard`; it needs `destructive`, so an agent is always asked. Why: with close-to-tray on, closing the window no longer quits and the tray icon exists only while Pine is hidden. Governs: `app.quit`, `window:quit`.

## Cases
| ID | Covers | Kind | Case |
|---|---|---|---|
| MGR-C19 | MGR-D6 | expected | Given a manager is live and close-to-tray is off, when the window is closed, then Pine hides to the tray |
| MGR-C1 | MGR-D5 | expected | Given `workspaces.closeToTray` on, when the window is closed, then it hides, Pine keeps running with its ptys alive, and the tray icon appears |
| MGR-C2 | MGR-D5 | expected | Given `workspaces.closeToTray` off, when the window is closed, then Pine quits as before, after `closeGuard` |
| MGR-C3 | MGR-D5 | expected | Given Pine hidden in the tray, when Show is picked, then the window shows and the tray icon goes away |
| MGR-C4 | MGR-D5 | expected | Given Pine hidden in the tray, when Quit is picked, then the window shows and quitting goes through `closeGuard` |
| MGR-C5 | MGR-D5 | unexpected | Given a settings.json that is missing, unreadable or holds a non-boolean `closeToTray`, when the window is closed, then it is treated as on (the default) |
| MGR-C6 | MGR-D5 | unexpected | Given `workspaces.closeToTray` on, when a quit was already approved, then windows close instead of hiding |
| MGR-C41 | MGR-D21 | expected | Given the packaged Pine running with its window hidden, when Pine is launched again, then the second launch exits and the window shows |
| MGR-C42 | MGR-D21 | unexpected | Given the packaged Pine running hidden, when Pine is launched again with `--hidden`, then nothing is shown |
| MGR-C43 | MGR-D22 | expected | Given the palette, when Quit is run, then Pine quits through `closeGuard`; an agent running `app.quit` is asked because it needs `destructive` |

## Open
