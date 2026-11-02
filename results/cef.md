# CEF spike results

## OS keyring

Test setup: the release `spike-cef` binary, a disk profile (`SPIKE_KIND=disk`), no `--password-store` switch, `ozone-platform=wayland`. Each case runs in a private `dbus-run-session`, a private `mutter --headless`, its own `XDG_RUNTIME_DIR`, `XDG_DATA_HOME` and `HOME`. The human's session bus and keyring were not used. A local HTTP server sets one cookie (`srv`) with the `Set-Cookie` header and logs the `Cookie` header of each request. Scripts: `spikes/cef/scripts/keyring.sh` (modes `unlocked`, `locked`, `none`) with `keyring-server.py`, `keyring-stamp.py`, `keyring-unlock.py`, `keyring-nosecret.conf`. Logs are in `/tmp/spike-kr/<case>/out-<run>`.

### 1. Keyring started and unlocked (`gnome-keyring-daemon --unlock`, test password on stdin)

| Check | Result |
|---|---|
| Paint | Pass. 70 frames per second at first, then 33 per second. The screenshot shows the page, the video and the GPUI menu. |
| Wheel reaches GPUI | Pass. `gpui-wheel` was logged and the page counter `wheel` went from 0 to 135. Mouse and keyboard also arrived. |
| Cookie encrypted with a keyring key | Pass. Both cookies in `profile/ctx-0/Cookies` have the `v11` prefix. The keyring file holds a new item (the Chromium safe-storage key). |
| Survives a restart | Pass. In run 2 (new daemon, same keyring file, same password) the first request already carried `srv=1; c=1`. So the `v11` cookies decrypt after a restart. |

### 2. Keyring locked, nobody answers the prompt

The login keyring existed and the daemon started without `--unlock`. No cookie, no page, no frame.

- `cef::initialize` returns in 0.16 s. The context becomes ready at once.
- The page never loads. No HTTP request reaches the server. `frames_active=0` for the whole run.
- The stall has no end that we saw: 130 s with no change in one run, 34 s in the others.
- The same result with a prompter on the compositor display (`gcr-prompter` activated, nobody answers) and without one.
- The GPUI app is fine. The tick loop logs every second and GPUI still received mouse and keyboard events (`gpui-mouse-down`, `gpui-key`) during the stall.
- If the keyring is unlocked 7 s after the start (the `Locked` property of the login collection became `false`), CEF does not recover in the next 27 s. A late unlock does not release it.
- The stall is in the CEF browser side (the OS crypt key fetch before the cookie store is usable), not in the app main thread. The pump keeps running, so starting CEF off the UI thread would not change anything. The page would still never load.
- Check: the same locked keyring with `--password-store=basic` loads at once (page request, 75 frames in the first second, wheel 135, cookies `v10`).

### 3. No Secret Service

Two sub-cases:

- D-Bus activation available but no running daemon (a normal desktop install): the bus starts `gnome-keyring-daemon` on the first request. It creates an empty, locked store. Result: the same permanent stall as case 2. A plain private `dbus-run-session` hit this first, so a "no keyring" test needs a bus without service files.
- A bus with no `org.freedesktop.secrets` and no activation (`keyring-nosecret.conf`): no stall. Paint, wheel, page load all pass. Cookies get the `v10` prefix (the fixed built-in key, no real protection). Cookies survive a restart (run 2 sent `srv=1; c=1`).

### What the app must do

- Never start CEF and hope. A locked or uninitialized keyring blocks the browser forever, and the app gets no error and no event.
- Decide before `cef::initialize`, because the password store is a process-wide switch: probe the Secret Service first, in the Rust app, with a short timeout and off the UI thread.
  - Service not on the bus and not activatable: start CEF. It takes the `v10` path alone. Say in settings that browser cookies are not encrypted with a keyring.
  - Service present and the default collection `Locked` is `false`: start CEF with the default (keyring, `v11`).
  - Service present and locked, or the probe times out: do not start CEF with the keyring. Ask the user to unlock (the `Unlock` call plus the system prompter), wait for the `Locked` property to turn `false`, then start CEF. If the user declines or the wait times out, start CEF with `--password-store=basic` and show a warning.
- A late unlock does not help a CEF that already started, so the app must wait for the unlock before it starts CEF, not after.
- Start CEF off the UI thread: no help. The UI never blocks in any case. What blocks is the page load inside CEF. The probe itself must be async so that the window opens at once.
- A browser pane needs a state "waiting for keyring" in its own UI, because no CEF event reports the stall.

### Not tried

- A real user answer to the gcr prompt (no way to click it in headless). The unlock was done through the gnome-keyring internal D-Bus call instead.
- KWallet and other Secret Service servers (KeePassXC, kwallet-secrets).
- A stall longer than 130 s, or any CEF-side timeout.
- Which thread inside CEF waits (no stack dump).
- Recovery with an unlock more than 27 s after the page load started.
