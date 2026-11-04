#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_model::agents::file_reference::line_reference;

#[test]
fn names_one_line_or_a_line_span() {
    assert_eq!(line_reference("/a/b.ts", 3, 3), "/a/b.ts:3");
    assert_eq!(line_reference("/a/b.ts", 3, 9), "/a/b.ts:3-9");
}
