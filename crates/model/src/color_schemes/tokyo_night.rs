use crate::theme::types::{Appearance, ColorScheme, TerminalColors};

pub(super) fn tokyo_night() -> ColorScheme {
    ColorScheme {
        id: "tokyo-night".to_owned(),
        name: "Tokyo Night".to_owned(),
        appearance: Appearance::Dark,
        colors: TerminalColors {
            background: "#1a1b26",
            foreground: "#c0caf5",
            cursor: "#c0caf5",
            cursor_accent: "#15161e",
            selection_background: "#33467c",
            selection_foreground: Some("#c0caf5"),
            black: "#15161e",
            red: "#f7768e",
            green: "#9ece6a",
            yellow: "#e0af68",
            blue: "#7aa2f7",
            magenta: "#bb9af7",
            cyan: "#7dcfff",
            white: "#a9b1d6",
            bright_black: "#414868",
            bright_red: "#f7768e",
            bright_green: "#9ece6a",
            bright_yellow: "#e0af68",
            bright_blue: "#7aa2f7",
            bright_magenta: "#bb9af7",
            bright_cyan: "#7dcfff",
            bright_white: "#c0caf5",
        },
    }
}
