use crate::theme::types::{Appearance, ColorScheme, TerminalColors};

pub(super) fn catppuccin_macchiato() -> ColorScheme {
    ColorScheme {
        id: "catppuccin-macchiato".to_owned(),
        name: "Catppuccin Macchiato".to_owned(),
        appearance: Appearance::Dark,
        colors: TerminalColors {
            background: "#24273a",
            foreground: "#cad3f5",
            cursor: "#f4dbd6",
            cursor_accent: "#24273a",
            selection_background: "#f4dbd6",
            selection_foreground: Some("#24273a"),
            black: "#494d64",
            red: "#ed8796",
            green: "#a6da95",
            yellow: "#eed49f",
            blue: "#8aadf4",
            magenta: "#f5bde6",
            cyan: "#8bd5ca",
            white: "#b8c0e0",
            bright_black: "#5b6078",
            bright_red: "#f2a7b2",
            bright_green: "#bde3b0",
            bright_yellow: "#f4e3c1",
            bright_blue: "#adc5f7",
            bright_magenta: "#f493da",
            bright_cyan: "#a5ded6",
            bright_white: "#a5adcb",
        },
    }
}
