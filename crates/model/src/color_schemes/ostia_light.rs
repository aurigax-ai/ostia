use crate::theme::types::{Appearance, ColorScheme, TerminalColors};

pub(super) fn ostia_light() -> ColorScheme {
    ColorScheme {
        id: "ostia-light".to_owned(),
        name: "Ostia Light".to_owned(),
        appearance: Appearance::Light,
        colors: TerminalColors {
            background: "#fbfcfd",
            foreground: "#24292f",
            cursor: "#0b62c4",
            cursor_accent: "#fbfcfd",
            selection_background: "rgba(11, 98, 196, 0.22)",
            black: "#2b303b",
            red: "#c62828",
            green: "#1b7f3b",
            yellow: "#8a6100",
            blue: "#1f5fbf",
            magenta: "#a1349f",
            cyan: "#0b7285",
            white: "#5f6672",
            bright_black: "#59616e",
            bright_red: "#d32f2f",
            bright_green: "#1a7a35",
            bright_yellow: "#946800",
            bright_blue: "#2b6fd6",
            bright_magenta: "#b53fb2",
            bright_cyan: "#0c7a8d",
            bright_white: "#3f4550",
            selection_foreground: None,
        },
    }
}
