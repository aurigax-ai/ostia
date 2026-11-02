import sys

import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi

APP_NAME = sys.argv[1] if len(sys.argv) > 1 else "spike-input"


def text_of(node):
    iface = node.get_text_iface()
    if iface is None:
        return None
    return Atspi.Text.get_text(iface, 0, Atspi.Text.get_character_count(iface))


def actions_of(node):
    iface = node.get_action_iface()
    if iface is None:
        return []
    return [iface.get_action_name(i) for i in range(iface.get_n_actions())]


def walk(node, depth):
    print(
        "  " * depth
        + f"{node.get_role_name()} name={node.get_name()!r} text={text_of(node)!r} actions={actions_of(node)}"
    )
    for index in range(node.get_child_count()):
        walk(node.get_child_at_index(index), depth + 1)


desktop = Atspi.get_desktop(0)
found = False
for index in range(desktop.get_child_count()):
    app = desktop.get_child_at_index(index)
    if app.get_name() == APP_NAME:
        found = True
        walk(app, 0)
if not found:
    sys.exit(f"application {APP_NAME!r} not on the AT-SPI desktop")
