#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_model::theme::panel_font_faces::panel_font_faces;

fn families_in(css: &str) -> Vec<&str> {
    css.lines()
        .map(|line| {
            let start = line.find("font-family: \"").unwrap() + "font-family: \"".len();
            let end = start + line[start..].find('"').unwrap();
            &line[start..end]
        })
        .collect()
}

#[test]
fn always_includes_the_fallback_families() {
    let css = panel_font_faces(&[]);
    assert_eq!(families_in(&css), ["Inter Variable", "Geist Mono Variable"]);
}

#[test]
fn adds_a_requested_bundled_family_in_the_fixed_order() {
    let css = panel_font_faces(&["Geist Mono Variable", "Geist Variable"]);
    assert_eq!(
        families_in(&css),
        ["Inter Variable", "Geist Variable", "Geist Mono Variable"]
    );
}

#[test]
fn ignores_a_family_it_does_not_bundle() {
    let css = panel_font_faces(&["Fira Code"]);
    assert_eq!(families_in(&css), ["Inter Variable", "Geist Mono Variable"]);
}

#[test]
fn writes_one_variable_weight_latin_face_per_line() {
    let css = panel_font_faces(&["Geist Variable"]);
    assert_eq!(css.lines().count(), 3);
    for line in css.lines() {
        assert!(line.starts_with("@font-face { font-family: \""), "{line}");
        assert!(line.contains("font-style: normal; font-weight: 100 900; font-display: swap;"));
        assert!(line.contains("src: url(\"data:font/woff2;base64,"));
        assert!(line.contains("\") format(\"woff2-variations\");"));
        assert!(line.contains("unicode-range: U+0000-00FF,U+0131,"));
        assert!(line.ends_with("U+FFFD; }"));
    }
}
