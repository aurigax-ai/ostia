use crate::theme::types::{Appearance, ColorScheme, TerminalColors};

pub(super) fn dracula() -> ColorScheme {
    ColorScheme {
        id: "dracula".to_owned(),
        name: "Dracula".to_owned(),
        appearance: Appearance::Dark,
        colors: TerminalColors {
            background: "#282a36",
            foreground: "#f8f8f2",
            cursor: "#f8f8f2",
            cursor_accent: "#282a36",
            selection_background: "#44475a",
            selection_foreground: Some("#ffffff"),
            black: "#21222c",
            red: "#ff5555",
            green: "#50fa7b",
            yellow: "#f1fa8c",
            blue: "#bd93f9",
            magenta: "#ff79c6",
            cyan: "#8be9fd",
            white: "#f8f8f2",
            bright_black: "#6272a4",
            bright_red: "#ff6e6e",
            bright_green: "#69ff94",
            bright_yellow: "#ffffa5",
            bright_blue: "#d6acff",
            bright_magenta: "#ff92df",
            bright_cyan: "#a4ffff",
            bright_white: "#ffffff",
        },
    }
}
