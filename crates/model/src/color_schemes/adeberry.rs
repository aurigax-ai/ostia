use crate::theme::types::{Appearance, ColorScheme, TerminalColors};

pub(super) fn adeberry() -> ColorScheme {
    ColorScheme {
        id: "adeberry".to_owned(),
        name: "Adeberry".to_owned(),
        appearance: Appearance::Dark,
        colors: TerminalColors {
            background: "#1d2022",
            foreground: "#d5dde3",
            cursor: "#00d8ff",
            cursor_accent: "#1d2022",
            selection_background: "rgba(83, 139, 181, 0.3)",
            black: "#313537",
            red: "#bf5f54",
            green: "#58c98c",
            yellow: "#cfd77c",
            blue: "#538bb5",
            magenta: "#c99bf9",
            cyan: "#5aceca",
            white: "#e3edf5",
            bright_black: "#5c6266",
            bright_red: "#d47466",
            bright_green: "#60ec9f",
            bright_yellow: "#e3ec93",
            bright_blue: "#5aceca",
            bright_magenta: "#d9b3fc",
            bright_cyan: "#6cfcf9",
            bright_white: "#f5fbff",
            selection_foreground: None,
        },
    }
}
