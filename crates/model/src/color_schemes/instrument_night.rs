use crate::theme::types::{Appearance, ColorScheme, TerminalColors};

pub(super) fn instrument_night() -> ColorScheme {
    ColorScheme {
        id: "instrument-night".to_owned(),
        name: "Instrument Night".to_owned(),
        appearance: Appearance::Dark,
        colors: TerminalColors {
            background: "#0a0c12",
            foreground: "#e7e9f0",
            cursor: "#f2b347",
            cursor_accent: "#0a0c12",
            selection_background: "rgba(242, 179, 71, 0.22)",
            black: "#1d2230",
            red: "#ff6b5e",
            green: "#5bd6a0",
            yellow: "#f2b347",
            blue: "#6ea8fe",
            magenta: "#c792ea",
            cyan: "#5ccfe6",
            white: "#c8ccd8",
            bright_black: "#6b7186",
            bright_red: "#ff8a80",
            bright_green: "#7ee6b8",
            bright_yellow: "#ffc874",
            bright_blue: "#8fbcff",
            bright_magenta: "#d7a8f5",
            bright_cyan: "#86e1f0",
            bright_white: "#ffffff",
            selection_foreground: None,
        },
    }
}
