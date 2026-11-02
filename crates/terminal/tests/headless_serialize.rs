#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_terminal::headless_screen::HeadlessScreen;
use ostia_testkit::fixture_text;
use serde_json::Value;

#[test]
fn serializes_the_same_text_as_the_wasm_headless_terminal() {
    let cases: Vec<Value> =
        serde_json::from_str(&fixture_text("rust/ghostty-serialize.json").unwrap()).unwrap();
    assert!(!cases.is_empty());
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let number = |key: &str| case[key].as_u64().unwrap();
        let mut screen = HeadlessScreen::new(
            u16::try_from(number("cols")).unwrap(),
            u16::try_from(number("rows")).unwrap(),
            2000,
        )
        .unwrap();
        screen.write_raw(case["input"].as_str().unwrap().as_bytes());
        let expected: Vec<String> = case["lines"]
            .as_array()
            .unwrap()
            .iter()
            .map(|line| line.as_str().unwrap().to_string())
            .collect();
        let got = screen.serialize(
            usize::try_from(number("from")).unwrap(),
            usize::try_from(number("to")).unwrap(),
        );
        assert_eq!(got, expected, "{name}");
    }
}
