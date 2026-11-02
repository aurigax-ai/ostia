import subprocess
import sys
import time

import gi

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib

out = sys.argv[1]
start_delay = float(sys.argv[2])
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)


def call(name, path, iface, method, args, signature):
    result = bus.call_sync(name, path, iface, method, GLib.Variant(signature, args) if signature else None, None, Gio.DBusCallFlags.NONE, 10000, None)
    return result.unpack()


RD = "org.gnome.Mutter.RemoteDesktop"
SC = "org.gnome.Mutter.ScreenCast"
rd_path = call(RD, "/org/gnome/Mutter/RemoteDesktop", RD, "CreateSession", None, None)[0]
session_id = bus.call_sync(RD, rd_path, "org.freedesktop.DBus.Properties", "Get", GLib.Variant("(ss)", (RD + ".Session", "SessionId")), None, Gio.DBusCallFlags.NONE, 5000, None).unpack()[0]
sc_path = call(SC, "/org/gnome/Mutter/ScreenCast", SC, "CreateSession", ({"remote-desktop-session-id": GLib.Variant("s", session_id)},), "(a{sv})")[0]
stream_path = call(SC, sc_path, SC + ".Session", "RecordMonitor", ("", {}), "(sa{sv})")[0]
node = {}
loop = GLib.MainLoop()


def on_added(conn, sender, path, iface, signal, params):
    node["id"] = params.unpack()[0]
    loop.quit()


bus.signal_subscribe(SC, SC + ".Stream", "PipeWireStreamAdded", stream_path, None, Gio.DBusSignalFlags.NONE, on_added)
call(RD, rd_path, RD + ".Session", "Start", None, None)
GLib.timeout_add_seconds(10, loop.quit)
loop.run()
print("stream node", node.get("id"), flush=True)


def rd(method, args, signature):
    call(RD, rd_path, RD + ".Session", method, args, signature)


def move(x, y):
    rd("NotifyPointerMotionAbsolute", (stream_path, float(x), float(y)), "(sdd)")


def click(button=272):
    rd("NotifyPointerButton", (button, True), "(ib)")
    time.sleep(0.05)
    rd("NotifyPointerButton", (button, False), "(ib)")


def key(code):
    rd("NotifyKeyboardKeycode", (code, True), "(ub)")
    time.sleep(0.03)
    rd("NotifyKeyboardKeycode", (code, False), "(ub)")
    time.sleep(0.08)


def shot(name):
    if "id" not in node:
        return
    try:
        run_shot(name)
    except subprocess.TimeoutExpired:
        print("shot timeout", name, flush=True)


def run_shot(name):
    subprocess.run(
        ["gst-launch-1.0", "pipewiresrc", f"path={node['id']}", "do-timestamp=true", "always-copy=true", "keepalive-time=100", "num-buffers=1", "!", "videoconvert", "!", "pngenc", "!", "filesink", f"location={out}/{name}.png"],
        timeout=15,
        stdout=open(f"{out}/gst-{name}.log", "w"),
        stderr=subprocess.STDOUT,
    )


time.sleep(start_delay)
shot("wl-before")
move(400, 300)
time.sleep(0.5)
for _ in range(3):
    rd("NotifyPointerAxis", (0.0, 15.0, 0), "(ddu)")
    time.sleep(0.1)
print("wheel sent", flush=True)
time.sleep(1)
move(200, 60)
time.sleep(0.3)
click()
time.sleep(0.5)
for code in (35, 18, 38, 38, 24, 28):
    key(code)
print("typed", flush=True)
time.sleep(1)
move(30, 20)
time.sleep(0.3)
click()
time.sleep(1.5)
shot("wl-menu")
print("done", flush=True)
