use crate::theme::types::{Appearance, ColorScheme, TerminalColors};

pub(super) fn github_dark() -> ColorScheme {
    ColorScheme {
        id: "github-dark".to_owned(),
        name: "GitHub Dark".to_owned(),
        appearance: Appearance::Dark,
        colors: TerminalColors {
            background: "#0d1117",
            foreground: "#e6edf3",
            cursor: "#2f81f7",
            cursor_accent: "#6fc1ff",
            selection_background: "#e6edf3",
            selection_foreground: Some("#0d1117"),
            black: "#484f58",
            red: "#ff7b72",
            green: "#3fb950",
            yellow: "#d29922",
            blue: "#58a6ff",
            magenta: "#bc8cff",
            cyan: "#39c5cf",
            white: "#b1bac4",
            bright_black: "#6e7681",
            bright_red: "#ffa198",
            bright_green: "#56d364",
            bright_yellow: "#e3b341",
            bright_blue: "#79c0ff",
            bright_magenta: "#d2a8ff",
            bright_cyan: "#56d4dd",
            bright_white: "#ffffff",
        },
    }
}
