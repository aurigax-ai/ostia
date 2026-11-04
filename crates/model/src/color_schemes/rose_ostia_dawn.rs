use crate::theme::types::{Appearance, ColorScheme, TerminalColors};

pub(super) fn rose_ostia_dawn() -> ColorScheme {
    ColorScheme {
        id: "rose-pine-dawn".to_owned(),
        name: "Rosé Pine Dawn".to_owned(),
        appearance: Appearance::Light,
        colors: TerminalColors {
            background: "#faf4ed",
            foreground: "#575279",
            cursor: "#575279",
            cursor_accent: "#faf4ed",
            selection_background: "#dfdad9",
            selection_foreground: Some("#575279"),
            black: "#f2e9e1",
            red: "#b4637a",
            green: "#286983",
            yellow: "#ea9d34",
            blue: "#56949f",
            magenta: "#907aa9",
            cyan: "#d7827e",
            white: "#575279",
            bright_black: "#9893a5",
            bright_red: "#b4637a",
            bright_green: "#286983",
            bright_yellow: "#ea9d34",
            bright_blue: "#56949f",
            bright_magenta: "#907aa9",
            bright_cyan: "#d7827e",
            bright_white: "#575279",
        },
    }
}
