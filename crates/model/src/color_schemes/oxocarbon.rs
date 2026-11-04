use crate::theme::types::{Appearance, ColorScheme, TerminalColors};

pub(super) fn oxocarbon() -> ColorScheme {
    ColorScheme {
        id: "oxocarbon".to_owned(),
        name: "Oxocarbon".to_owned(),
        appearance: Appearance::Dark,
        colors: TerminalColors {
            background: "#161616",
            foreground: "#f2f4f8",
            cursor: "#ffffff",
            cursor_accent: "#000000",
            selection_background: "#393939",
            selection_foreground: Some("#f2f4f8"),
            black: "#262626",
            red: "#ee5396",
            green: "#42be65",
            yellow: "#ffe97b",
            blue: "#33b1ff",
            magenta: "#ff7eb6",
            cyan: "#3ddbd9",
            white: "#dde1e6",
            bright_black: "#393939",
            bright_red: "#ee5396",
            bright_green: "#42be65",
            bright_yellow: "#ffe97b",
            bright_blue: "#33b1ff",
            bright_magenta: "#ff7eb6",
            bright_cyan: "#3ddbd9",
            bright_white: "#ffffff",
        },
    }
}
