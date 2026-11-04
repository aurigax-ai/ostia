use crate::theme::types::{Appearance, ColorScheme, TerminalColors};

pub(super) fn rose_ostia() -> ColorScheme {
    ColorScheme {
        id: "rose-pine".to_owned(),
        name: "Rosé Pine".to_owned(),
        appearance: Appearance::Dark,
        colors: TerminalColors {
            background: "#191724",
            foreground: "#e0def4",
            cursor: "#e0def4",
            cursor_accent: "#191724",
            selection_background: "#403d52",
            selection_foreground: Some("#e0def4"),
            black: "#26233a",
            red: "#eb6f92",
            green: "#31748f",
            yellow: "#f6c177",
            blue: "#9ccfd8",
            magenta: "#c4a7e7",
            cyan: "#ebbcba",
            white: "#e0def4",
            bright_black: "#6e6a86",
            bright_red: "#eb6f92",
            bright_green: "#31748f",
            bright_yellow: "#f6c177",
            bright_blue: "#9ccfd8",
            bright_magenta: "#c4a7e7",
            bright_cyan: "#ebbcba",
            bright_white: "#e0def4",
        },
    }
}
