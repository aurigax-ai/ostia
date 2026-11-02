use std::sync::LazyLock;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;

const LATIN_RANGE: &str = "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";

const FALLBACK_FAMILIES: [&str; 2] = ["Inter Variable", "Geist Mono Variable"];

static PANEL_FONT_FILES: LazyLock<[(&str, String); 3]> = LazyLock::new(|| {
    [
        (
            "Inter Variable",
            STANDARD.encode(include_bytes!(
                "../../assets/fonts/inter-latin-wght-normal.woff2"
            )),
        ),
        (
            "Geist Variable",
            STANDARD.encode(include_bytes!(
                "../../assets/fonts/geist-latin-wght-normal.woff2"
            )),
        ),
        (
            "Geist Mono Variable",
            STANDARD.encode(include_bytes!(
                "../../assets/fonts/geist-mono-latin-wght-normal.woff2"
            )),
        ),
    ]
});

pub fn panel_font_faces(families: &[&str]) -> String {
    PANEL_FONT_FILES
        .iter()
        .filter(|(family, _)| families.contains(family) || FALLBACK_FAMILIES.contains(family))
        .map(|(family, data)| {
            format!(
                "@font-face {{ font-family: \"{family}\"; font-style: normal; font-weight: 100 900; font-display: swap; src: url(\"data:font/woff2;base64,{data}\") format(\"woff2-variations\"); unicode-range: {LATIN_RANGE}; }}"
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}
