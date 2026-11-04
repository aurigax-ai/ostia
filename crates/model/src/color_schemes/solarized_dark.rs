use crate::theme::types::{Appearance, ColorScheme, TerminalColors};

pub(super) fn solarized_dark() -> ColorScheme {
    ColorScheme {
        id: "solarized-dark".to_owned(),
        name: "Solarized Dark".to_owned(),
        appearance: Appearance::Dark,
        colors: TerminalColors {
            background: "#002b36",
            foreground: "#839496",
            cursor: "#839496",
            cursor_accent: "#073642",
            selection_background: "#073642",
            selection_foreground: Some("#93a1a1"),
            black: "#073642",
            red: "#dc322f",
            green: "#859900",
            yellow: "#b58900",
            blue: "#268bd2",
            magenta: "#d33682",
            cyan: "#2aa198",
            white: "#eee8d5",
            bright_black: "#335e69",
            bright_red: "#cb4b16",
            bright_green: "#586e75",
            bright_yellow: "#657b83",
            bright_blue: "#839496",
            bright_magenta: "#6c71c4",
            bright_cyan: "#93a1a1",
            bright_white: "#fdf6e3",
        },
    }
}
