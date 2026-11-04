use crate::theme::types::{Appearance, ColorScheme, TerminalColors};

pub(super) fn monokai_classic() -> ColorScheme {
    ColorScheme {
        id: "monokai-classic".to_owned(),
        name: "Monokai Classic".to_owned(),
        appearance: Appearance::Dark,
        colors: TerminalColors {
            background: "#272822",
            foreground: "#fdfff1",
            cursor: "#c0c1b5",
            cursor_accent: "#8d8e82",
            selection_background: "#57584f",
            selection_foreground: Some("#fdfff1"),
            black: "#272822",
            red: "#f92672",
            green: "#a6e22e",
            yellow: "#e6db74",
            blue: "#fd971f",
            magenta: "#ae81ff",
            cyan: "#66d9ef",
            white: "#fdfff1",
            bright_black: "#6e7066",
            bright_red: "#f92672",
            bright_green: "#a6e22e",
            bright_yellow: "#e6db74",
            bright_blue: "#fd971f",
            bright_magenta: "#ae81ff",
            bright_cyan: "#66d9ef",
            bright_white: "#fdfff1",
        },
    }
}
