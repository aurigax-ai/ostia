use ostia_model::files::pdf_text::{PDF_MAX_PAGES, TextItem, item_lines};

fn item(text: &str, has_eol: bool) -> TextItem {
    TextItem {
        text: Some(text.to_owned()),
        has_eol,
    }
}

#[test]
fn joins_items_into_lines_at_each_end_of_line() {
    let items = [
        item("Hello", false),
        item(" world", true),
        item("", true),
        item("Next line", false),
    ];
    assert_eq!(item_lines(&items), ["Hello world", "Next line"]);
}

#[test]
fn keeps_the_last_line_that_has_no_end_of_line() {
    assert_eq!(item_lines(&[item("tail", false)]), ["tail"]);
}

#[test]
fn trims_each_line_and_drops_blank_ones() {
    let items = [item("  padded  ", true), item("   ", true), item("x", true)];
    assert_eq!(item_lines(&items), ["padded", "x"]);
}

#[test]
fn an_item_without_text_adds_nothing_but_still_ends_the_line() {
    let items = [
        item("a", false),
        TextItem {
            text: None,
            has_eol: true,
        },
        item("b", false),
    ];
    assert_eq!(item_lines(&items), ["a", "b"]);
}

#[test]
fn no_items_give_no_lines() {
    assert!(item_lines(&[]).is_empty());
}

#[test]
fn the_page_limit_is_three_hundred() {
    assert_eq!(PDF_MAX_PAGES, 300);
}
