use crate::theme::types::{Appearance, ColorScheme, TerminalColors};

pub(super) fn tokyo_night_day() -> ColorScheme {
    ColorScheme {
        id: "tokyo-night-day".to_owned(),
        name: "Tokyo Night Day".to_owned(),
        appearance: Appearance::Light,
        colors: TerminalColors {
            background: "#e1e2e7",
            foreground: "#3760bf",
            cursor: "#3760bf",
            cursor_accent: "#e1e2e7",
            selection_background: "#99a7df",
            selection_foreground: Some("#3760bf"),
            black: "#e9e9ed",
            red: "#f52a65",
            green: "#587539",
            yellow: "#8c6c3e",
            blue: "#2e7de9",
            magenta: "#9854f1",
            cyan: "#007197",
            white: "#6172b0",
            bright_black: "#a1a6c5",
            bright_red: "#f52a65",
            bright_green: "#587539",
            bright_yellow: "#8c6c3e",
            bright_blue: "#2e7de9",
            bright_magenta: "#9854f1",
            bright_cyan: "#007197",
            bright_white: "#3760bf",
        },
    }
}
