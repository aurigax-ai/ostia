use crate::theme::types::{Appearance, ColorScheme, TerminalColors};

pub(super) fn one_dark_vivid() -> ColorScheme {
    ColorScheme {
        id: "one-dark-vivid".to_owned(),
        name: "One Dark Vivid".to_owned(),
        appearance: Appearance::Dark,
        colors: TerminalColors {
            background: "#282c34",
            foreground: "#d7dae0",
            cursor: "#61afef",
            cursor_accent: "#282c34",
            selection_background: "rgba(97, 175, 239, 0.25)",
            black: "#3a4150",
            red: "#ef596f",
            green: "#89ca78",
            yellow: "#e5c07b",
            blue: "#61afef",
            magenta: "#d55fde",
            cyan: "#56b6c2",
            white: "#d7dae0",
            bright_black: "#636d83",
            bright_red: "#ef596f",
            bright_green: "#89ca78",
            bright_yellow: "#e5c07b",
            bright_blue: "#61afef",
            bright_magenta: "#d55fde",
            bright_cyan: "#56b6c2",
            bright_white: "#ffffff",
            selection_foreground: None,
        },
    }
}
