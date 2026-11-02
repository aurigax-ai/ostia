import subprocess
import sys
import time

import gi

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib

KEYCODES = {
    "esc": 1, "comma": 51, "backslash": 43, "enter": 28, "tab": 15, "ctrl": 29, "shift": 42, "alt": 56, "space": 57,
    "a": 30, "b": 48, "c": 46, "d": 32, "e": 18, "f": 33, "g": 34, "h": 35, "i": 23, "j": 36,
    "k": 37, "l": 38, "m": 50, "n": 49, "o": 24, "p": 25, "q": 16, "r": 19, "s": 31, "t": 20,
    "u": 22, "v": 47, "w": 17, "x": 45, "y": 21, "z": 44,
}
REMOTE = "org.gnome.Mutter.RemoteDesktop"
CAST = "org.gnome.Mutter.ScreenCast"
BUTTON_LEFT = 272

out, name, settle, keys = sys.argv[1], sys.argv[2], float(sys.argv[3]), sys.argv[4]
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)


def call(owner, path, interface, method, args=None, signature=None):
    body = GLib.Variant(signature, args) if signature else None
    return bus.call_sync(
        owner, path, interface, method, body, None, Gio.DBusCallFlags.NONE, 10000, None
    ).unpack()


remote_path = call(REMOTE, "/org/gnome/Mutter/RemoteDesktop", REMOTE, "CreateSession")[0]
session_id = call(
    REMOTE, remote_path, "org.freedesktop.DBus.Properties", "Get",
    (REMOTE + ".Session", "SessionId"), "(ss)",
)[0]
cast_path = call(
    CAST, "/org/gnome/Mutter/ScreenCast", CAST, "CreateSession",
    ({"remote-desktop-session-id": GLib.Variant("s", session_id)},), "(a{sv})",
)[0]
stream_path = call(CAST, cast_path, CAST + ".Session", "RecordMonitor", ("", {}), "(sa{sv})")[0]

node = {}
loop = GLib.MainLoop()


def stream_added(_conn, _sender, _path, _iface, _signal, params):
    node["id"] = params.unpack()[0]
    loop.quit()


bus.signal_subscribe(
    CAST, CAST + ".Stream", "PipeWireStreamAdded", stream_path, None,
    Gio.DBusSignalFlags.NONE, stream_added,
)
call(REMOTE, remote_path, REMOTE + ".Session", "Start")
GLib.timeout_add_seconds(10, loop.quit)
loop.run()
if "id" not in node:
    sys.exit("no PipeWire stream")


def press(code, down):
    call(REMOTE, remote_path, REMOTE + ".Session", "NotifyKeyboardKeycode", (code, down), "(ub)")


def click(x, y):
    session = REMOTE + ".Session"
    call(REMOTE, remote_path, session, "NotifyPointerMotionAbsolute", (stream_path, x, y), "(sdd)")
    time.sleep(0.1)
    call(REMOTE, remote_path, session, "NotifyPointerButton", (BUTTON_LEFT, True), "(ib)")
    time.sleep(0.05)
    call(REMOTE, remote_path, session, "NotifyPointerButton", (BUTTON_LEFT, False), "(ib)")
    time.sleep(1.0)


time.sleep(settle)
for chord in keys.split():
    if chord.startswith("click:"):
        x, y = chord.removeprefix("click:").split(",")
        click(float(x), float(y))
        continue
    codes = [KEYCODES[part] for part in chord.split("+")]
    for code in codes:
        press(code, True)
        time.sleep(0.03)
    for code in reversed(codes):
        press(code, False)
        time.sleep(0.03)
    time.sleep(1.0)

with open(f"{out}/{name}.gst.log", "w") as log:
    subprocess.run(
        [
            "gst-launch-1.0", "pipewiresrc", f"path={node['id']}", "do-timestamp=true",
            "always-copy=true", "keepalive-time=100", "num-buffers=1", "!", "videoconvert", "!",
            "pngenc", "!", "filesink", f"location={out}/{name}.png",
        ],
        timeout=30, stdout=log, stderr=subprocess.STDOUT, check=True,
    )
print(f"{out}/{name}.png")
