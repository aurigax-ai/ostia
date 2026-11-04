use crate::theme::types::{Appearance, ColorScheme, TerminalColors};

pub(super) fn catppuccin_frappe() -> ColorScheme {
    ColorScheme {
        id: "catppuccin-frappe".to_owned(),
        name: "Catppuccin Frappé".to_owned(),
        appearance: Appearance::Dark,
        colors: TerminalColors {
            background: "#303446",
            foreground: "#c6d0f5",
            cursor: "#f2d5cf",
            cursor_accent: "#303446",
            selection_background: "#f2d5cf",
            selection_foreground: Some("#303446"),
            black: "#51576d",
            red: "#e78284",
            green: "#a6d189",
            yellow: "#e5c890",
            blue: "#8caaee",
            magenta: "#f4b8e4",
            cyan: "#81c8be",
            white: "#b5bfe2",
            bright_black: "#626880",
            bright_red: "#eda0a2",
            bright_green: "#b9dba2",
            bright_yellow: "#ecd7ae",
            bright_blue: "#adc2f3",
            bright_magenta: "#f38ed8",
            bright_cyan: "#98d2ca",
            bright_white: "#a5adce",
        },
    }
}
