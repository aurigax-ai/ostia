#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_browser::guest_link_clicks::{LINK_CLICK_SCRIPT, clicked_link_of};

fn marker() -> String {
    let source = &LINK_CLICK_SCRIPT.source;
    let start = source.find("[ostia-link-click ").unwrap();
    let end = start + source[start..].find("] ").unwrap() + 2;
    source[start..end].to_owned()
}

#[test]
fn runs_in_its_own_isolated_world() {
    assert_eq!(LINK_CLICK_SCRIPT.world_name, "ostia-link-clicks");
}

#[test]
fn reports_the_address_of_a_clicked_link_to_main_before_the_pages_own_listeners() {
    let source = &LINK_CLICK_SCRIPT.source;
    assert!(source.starts_with("addEventListener('click', (event) => {"));
    assert!(source.ends_with("}, true);"));
    assert!(source.contains("target.closest('a[href], area[href]')"));
    assert!(source.contains(&format!("console.debug(\"{}\" + link.href)", marker())));
    assert_eq!(
        clicked_link_of(&format!("{}https://docs.example.com/a", marker())).as_deref(),
        Some("https://docs.example.com/a")
    );
}

#[test]
fn reports_nothing_for_a_click_the_page_made_itself_or_another_button() {
    let source = &LINK_CLICK_SCRIPT.source;
    assert!(source.contains("if (!event.isTrusted || event.button !== 0) return;"));
}

#[test]
fn reports_nothing_for_a_click_outside_a_link_or_on_a_non_element() {
    let source = &LINK_CLICK_SCRIPT.source;
    assert!(source.contains("target instanceof Element ? target.closest("));
    assert!(source.contains(": null;"));
    assert!(source.contains("if (link) console.debug("));
}

#[test]
fn reads_only_the_scripts_own_messages_never_a_pages_look_alike() {
    assert_eq!(clicked_link_of("https://docs.example.com/a"), None);
    assert_eq!(
        clicked_link_of("[ostia-link-click] https://docs.example.com/a"),
        None
    );
}

#[test]
fn marks_its_messages_with_a_random_id_in_the_uuid_shape() {
    let marker = marker();
    let id = marker
        .strip_prefix("[ostia-link-click ")
        .and_then(|rest| rest.strip_suffix("] "))
        .unwrap();
    assert_eq!(id.len(), 36);
    assert_eq!(id.matches('-').count(), 4);
    assert!(
        id.chars()
            .all(|c| c == '-' || c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
    );
}

#[test]
fn returns_an_empty_address_for_a_message_that_is_only_the_marker() {
    assert_eq!(clicked_link_of(&marker()).as_deref(), Some(""));
}
