import sys

import gi

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib

bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
secrets = "org.freedesktop.secrets"
session = bus.call_sync(secrets, "/org/freedesktop/secrets", "org.freedesktop.Secret.Service", "OpenSession", GLib.Variant("(sv)", ("plain", GLib.Variant("s", ""))), None, Gio.DBusCallFlags.NONE, 10000, None).unpack()[1]
bus.call_sync(
    secrets,
    "/org/freedesktop/secrets",
    "org.gnome.keyring.InternalUnsupportedGuiltRiddenInterface",
    "UnlockWithMasterPassword",
    GLib.Variant("(o(oayays))", ("/org/freedesktop/secrets/collection/login", (session, b"", sys.argv[1].encode(), "text/plain"))),
    None,
    Gio.DBusCallFlags.NONE,
    10000,
    None,
)
print("unlocked")
