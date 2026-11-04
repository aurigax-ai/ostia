use crate::theme::types::{Appearance, ColorScheme, TerminalColors};

pub(super) fn kanagawa_wave() -> ColorScheme {
    ColorScheme {
        id: "kanagawa-wave".to_owned(),
        name: "Kanagawa Wave".to_owned(),
        appearance: Appearance::Dark,
        colors: TerminalColors {
            background: "#1f1f28",
            foreground: "#dcd7ba",
            cursor: "#dcd7ba",
            cursor_accent: "#1f1f28",
            selection_background: "#dcd7ba",
            selection_foreground: Some("#1f1f28"),
            black: "#090618",
            red: "#c34043",
            green: "#76946a",
            yellow: "#c0a36e",
            blue: "#7e9cd8",
            magenta: "#957fb8",
            cyan: "#6a9589",
            white: "#c8c093",
            bright_black: "#727169",
            bright_red: "#e82424",
            bright_green: "#98bb6c",
            bright_yellow: "#e6c384",
            bright_blue: "#7fb4ca",
            bright_magenta: "#938aa9",
            bright_cyan: "#7aa89f",
            bright_white: "#dcd7ba",
        },
    }
}
