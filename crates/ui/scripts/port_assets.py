#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["fonttools>=4.57", "brotli>=1.1"]
# ///
import re
import shutil
import sys
from pathlib import Path

from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

CRATE = Path(__file__).resolve().parent.parent
REPO = CRATE.parent.parent
RENDERER = REPO / "src/renderer"
MODULES = Path(sys.argv[1]) if len(sys.argv) > 1 else REPO / "node_modules"
PNPM = MODULES / ".pnpm"
PHOSPHOR = PNPM / "@phosphor-icons+core@2.1.1/node_modules/@phosphor-icons/core/assets"
INTER = PNPM / "@fontsource-variable+inter@5.3.0/node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2"
GEIST = PNPM / "@fontsource-variable+geist-mono@5.3.0/node_modules/@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2"
HACK = RENDERER / "assets/fonts"

KIT_ICONS = {
    "a-large-small": "text-aa", "arrow-down": "arrow-down", "arrow-left": "arrow-left",
    "arrow-right": "arrow-right", "arrow-up": "arrow-up", "asterisk": "asterisk",
    "ban": "prohibit", "battery-charging": "battery-charging", "battery-full": "battery-full",
    "battery-low": "battery-low", "battery-medium": "battery-medium",
    "battery-warning": "battery-warning", "battery": "battery-empty", "bell": "bell",
    "book-open": "book-open", "bot": "robot", "building-2": "buildings", "calendar": "calendar",
    "case-sensitive": "text-aa", "chart-pie": "chart-pie", "check": "check",
    "chevron-down": "caret-down", "chevron-left": "caret-left", "chevron-right": "caret-right",
    "chevron-up": "caret-up", "chevrons-up-down": "caret-up-down", "circle-alert": "warning-circle",
    "circle-check": "check-circle", "circle-user": "user-circle", "circle-x": "x-circle",
    "close": "x", "copy": "copy", "cpu": "cpu", "dash": "minus", "delete": "backspace",
    "ellipsis-vertical": "dots-three-vertical", "ellipsis": "dots-three",
    "external-link": "arrow-square-out", "eye-off": "eye-slash", "eye": "eye",
    "file-text": "file-text", "file": "file", "folder-closed": "folder-simple",
    "folder-open": "folder-open", "folder": "folder-simple", "frame": "selection",
    "gallery-vertical-end": "stack", "github": "github-logo", "globe": "globe",
    "hard-drive": "hard-drive", "heart-off": "heart-break", "heart": "heart", "inbox": "tray",
    "info": "info", "inspector": "cursor-click", "layout-dashboard": "layout",
    "loader-circle": "circle-notch", "loader": "circle-notch", "map": "map-trifold",
    "maximize": "corners-out", "memory-stick": "memory", "menu": "list", "mic": "microphone",
    "minimize": "corners-in", "minus": "minus", "moon": "moon", "network": "tree-structure",
    "palette": "palette", "panel-bottom-open": "rows", "panel-bottom": "rows",
    "panel-left-close": "sidebar-simple", "panel-left-open": "sidebar-simple",
    "panel-left": "sidebar-simple", "panel-right-close": "sidebar-simple",
    "panel-right-open": "sidebar-simple", "panel-right": "sidebar-simple", "pause": "pause",
    "play": "play", "plus": "plus", "redo-2": "arrow-clockwise", "redo": "arrow-clockwise",
    "refresh-cw": "arrows-clockwise", "replace": "swap", "resize-corner": "arrows-out-simple",
    "rotate-cw": "arrow-clockwise", "search": "magnifying-glass", "settings-2": "sliders-horizontal",
    "settings": "gear-six", "sort-ascending": "sort-ascending", "sort-descending": "sort-descending",
    "square-terminal": "terminal-window", "square": "square", "star-fill": "star",
    "star-off": "star", "star": "star", "sun": "sun", "thumbs-down": "thumbs-down",
    "thumbs-up": "thumbs-up", "triangle-alert": "warning", "undo-2": "arrow-counter-clockwise",
    "undo": "arrow-counter-clockwise", "user": "user", "window-close": "x",
    "window-maximize": "square", "window-minimize": "minus", "window-restore": "copy",
}

SEMANTIC = [
    "bg", "bg-sunken", "surface-1", "surface-2", "surface-3", "line", "line-strong", "fg",
    "fg-muted", "fg-dim", "brand", "brand-bright", "brand-glow", "attn", "attn-glow", "attn-fg",
    "warn-fg", "ok", "add", "del",
]
SCHEME = [
    "background", "foreground", "cursor", "cursorAccent", "selectionBackground", "black", "red",
    "green", "yellow", "blue", "magenta", "cyan", "white", "brightBlack", "brightRed",
    "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
]


def snake(name):
    return re.sub(r"[A-Z]", lambda m: "_" + m.group(0).lower(), name).replace("-", "_")


def pascal(kebab):
    return "".join(part.capitalize() for part in kebab.split("-"))


def kebab(pascal_name):
    spaced = re.sub(r"(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])", "-", pascal_name)
    return re.sub(r"(?<=[a-zA-Z])(?=[0-9])", "-", spaced).lower()


def used_icons():
    names = set(KIT_ICONS.values())
    pattern = re.compile(r"import\s+\{([^}]*)\}\s+from\s+'@phosphor-icons/react'", re.S)
    for path in RENDERER.rglob("*.ts*"):
        if ".test." in path.name:
            continue
        for block in pattern.findall(path.read_text()):
            for item in block.split(","):
                item = item.strip().removeprefix("type ").split(" as ")[0].strip()
                if item.endswith("Icon") and item != "Icon":
                    names.add(kebab(item[: -len("Icon")]))
    return names


def copy_icons(names):
    missing = []
    kept = []
    target = CRATE / "assets/icons"
    shutil.rmtree(target, ignore_errors=True)
    (target / "regular").mkdir(parents=True)
    (target / "bold").mkdir(parents=True)
    for name in sorted(names):
        regular = PHOSPHOR / "regular" / f"{name}.svg"
        bold = PHOSPHOR / "bold" / f"{name}-bold.svg"
        if not regular.exists() or not bold.exists():
            missing.append(name)
            continue
        shutil.copy(regular, target / "regular" / f"{name}.svg")
        shutil.copy(bold, target / "bold" / f"{name}.svg")
        kept.append(name)
    return kept, missing


def write_icon_table(names):
    lines = ["icon_table! {"]
    for name in names:
        lines.append(f'    {pascal(name)} => "{name}",')
    lines.append("}")
    lines.append("")
    lines.append("pub(crate) fn kit_icon_target(kit_name: &str) -> Option<&'static str> {")
    lines.append("    match kit_name {")
    for kit, target in sorted(KIT_ICONS.items()):
        lines.append(f'        "{kit}" => Some("{target}"),')
    lines.append("        _ => None,")
    lines.append("    }")
    lines.append("}")
    (CRATE / "src/icon_table.rs").write_text("\n".join(lines) + "\n")


def block_after(text, marker):
    start = text.index("{", text.index(marker))
    depth = 0
    for position in range(start, len(text)):
        if text[position] == "{":
            depth += 1
        elif text[position] == "}":
            depth -= 1
            if depth == 0:
                return text[start + 1 : position]
    raise ValueError(marker)


def fields(block):
    return dict(re.findall(r"'?([A-Za-z0-9-]+)'?:\s*'([^']*)'", block))


def color_literal(value):
    value = value.strip()
    hex_match = re.fullmatch(r"#([0-9a-fA-F]{6})", value)
    if hex_match:
        return f"Rgba8::rgb(0x{hex_match.group(1).lower()})"
    short = re.fullmatch(r"#([0-9a-fA-F]{3})", value)
    if short:
        full = "".join(c * 2 for c in short.group(1)).lower()
        return f"Rgba8::rgb(0x{full})"
    rgba = re.fullmatch(r"rgba\((\d+),\s*(\d+),\s*(\d+),\s*([0-9.]+)\)", value)
    if rgba:
        r, g, b, a = rgba.groups()
        packed = f"{int(r):02x}{int(g):02x}{int(b):02x}"
        return f"Rgba8::rgba(0x{packed}, {float(a)})"
    raise ValueError(value)


def write_theme_data():
    out = ["use crate::color::Rgba8;", "use crate::theme::{Appearance, ColorScheme, ThemeSource};", ""]
    source = (RENDERER / "lib/theme/builtin.ts").read_text()
    themes = re.findall(r"const (\w+): Theme = \{", source)
    out.append("pub(crate) const THEMES: &[ThemeSource] = &[")
    for variable in themes:
        block = block_after(source, f"const {variable}: Theme =")
        header = fields(block[: block.index("tokens")])
        tokens = fields(block_after(block, "tokens:"))
        out.append("    ThemeSource {")
        out.append(f'        id: "{header["id"]}",')
        out.append(f'        name: "{header["name"]}",')
        appearance = "Dark" if header["appearance"] == "dark" else "Light"
        out.append(f"        appearance: Appearance::{appearance},")
        out.append(f'        color_scheme: "{header["colorScheme"]}",')
        for key in SEMANTIC:
            out.append(f"        {snake(key)}: {color_literal(tokens[key])},")
        out.append("    },")
    out.append("];")
    out.append("")
    list_source = (RENDERER / "lib/colorSchemes/builtinColorSchemes.ts").read_text()
    ordered = re.findall(r"^  (\w+),$", list_source, re.M)
    imports = dict(re.findall(r"import \{ (\w+) \} from '\./(\w+)'", list_source))
    out.append("pub(crate) const COLOR_SCHEMES: &[ColorScheme] = &[")
    for variable in ordered:
        text = (RENDERER / "lib/colorSchemes" / f"{imports[variable]}.ts").read_text()
        head = fields(text[: text.index("colors:")])
        colors = fields(block_after(text, "colors:"))
        out.append("    ColorScheme {")
        out.append(f'        id: "{head["id"]}",')
        out.append(f'        name: "{head["name"]}",')
        appearance = "Dark" if head["appearance"] == "dark" else "Light"
        out.append(f"        appearance: Appearance::{appearance},")
        for key in SCHEME:
            value = colors.get(key)
            if value is None and key == "cursorAccent":
                value = colors["background"]
            out.append(f"        {snake(key)}: {color_literal(value)},")
        out.append("    },")
    out.append("];")
    (CRATE / "src/theme_data.rs").write_text("\n".join(out) + "\n")


def static_instance(source, weight, family, style, out_name):
    font = TTFont(source)
    instance = instantiateVariableFont(font, {"wght": weight}, updateFontNames=False)
    name_table = instance["name"]
    full = f"{family} {style}"
    for record in list(name_table.names):
        if record.nameID in (16, 17, 21, 22, 25):
            name_table.removeNames(nameID=record.nameID)
    for platform, encoding, language in ((3, 1, 0x409), (1, 0, 0)):
        name_table.setName(family, 1, platform, encoding, language)
        name_table.setName("Regular", 2, platform, encoding, language)
        name_table.setName(full, 4, platform, encoding, language)
        name_table.setName(full.replace(" ", "-"), 6, platform, encoding, language)
    instance["OS/2"].usWeightClass = weight
    instance.flavor = None
    instance.save(CRATE / "assets/fonts" / out_name)


def port_fonts():
    target = CRATE / "assets/fonts"
    shutil.rmtree(target, ignore_errors=True)
    target.mkdir(parents=True)
    for weight, style in ((400, "Regular"), (500, "Medium"), (600, "SemiBold")):
        static_instance(INTER, weight, "Inter", style, f"Inter-{style}.ttf")
        static_instance(GEIST, weight, "Geist Mono", style, f"GeistMono-{style}.ttf")
    shutil.copy(INTER.parent.parent / "LICENSE", target / "Inter-LICENSE.txt")
    shutil.copy(GEIST.parent.parent / "LICENSE", target / "GeistMono-LICENSE.txt")
    for style in ("Regular", "Bold", "Italic", "BoldItalic"):
        font = TTFont(HACK / f"HackNerdFontMono-{style}.woff2")
        font.flavor = None
        font.save(target / f"HackNerdFontMono-{style}.ttf")


def main():
    names, missing = copy_icons(used_icons())
    write_icon_table(names)
    write_theme_data()
    port_fonts()
    print(f"icons={len(names)} missing={missing}")


main()
