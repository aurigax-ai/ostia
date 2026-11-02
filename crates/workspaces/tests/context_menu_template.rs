#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::dict::{en, zh_hant};
use ostia_workspaces::context_menu_template::{
    ContextPage, ContextParams, EditFlags, MenuAction, MenuItem, Referrer, context_menu_template,
};
use serde_json::Value;

fn flags() -> EditFlags {
    EditFlags {
        can_undo: false,
        can_redo: false,
        can_cut: false,
        can_copy: false,
        can_paste: true,
        can_select_all: true,
    }
}

fn params(change: impl FnOnce(&mut ContextParams)) -> ContextParams {
    let mut base = ContextParams {
        is_editable: false,
        edit_flags: flags(),
        selection_text: String::new(),
        link_url: String::new(),
        media_type: "none".to_owned(),
        has_image_contents: false,
        referrer_policy: "strict-origin-when-cross-origin".to_owned(),
        frame_url: String::new(),
        page_url: "https://site.example/".to_owned(),
        x: 10,
        y: 20,
    };
    change(&mut base);
    base
}

const APP_PAGE: ContextPage = ContextPage {
    navigation: false,
    can_go_back: false,
    can_go_forward: false,
};

const WEB_PAGE: ContextPage = ContextPage {
    navigation: true,
    can_go_back: true,
    can_go_forward: false,
};

fn en_text() -> &'static Value {
    &en()["native"]["contextMenu"]
}

fn zh_text() -> &'static Value {
    &zh_hant()["native"]["contextMenu"]
}

fn shape(items: &[MenuItem]) -> Vec<String> {
    items
        .iter()
        .map(|item| match item {
            MenuItem::Separator => "-".to_owned(),
            MenuItem::Role { role, enabled } => {
                format!("{}{}", role.name(), off(*enabled))
            }
            MenuItem::Action { label, enabled, .. } => format!("{label}{}", off(*enabled)),
        })
        .collect()
}

fn off(enabled: Option<bool>) -> &'static str {
    if enabled == Some(false) { " (off)" } else { "" }
}

fn labels(items: &[MenuItem]) -> Vec<String> {
    items
        .iter()
        .filter_map(|item| match item {
            MenuItem::Action { label, .. } => Some(label.clone()),
            _ => None,
        })
        .collect()
}

fn action(item: &MenuItem) -> &MenuAction {
    match item {
        MenuItem::Action { action, .. } => action,
        other => panic!("not an action item: {other:?}"),
    }
}

#[test]
fn offers_edit_actions_in_a_text_field_enabled_by_what_the_field_can_do() {
    let items = context_menu_template(
        &params(|p| p.is_editable = true),
        &APP_PAGE,
        false,
        en_text(),
    );
    assert_eq!(
        shape(&items),
        [
            "undo (off)",
            "redo (off)",
            "-",
            "cut (off)",
            "copy (off)",
            "paste",
            "selectAll",
        ]
    );
}

#[test]
fn offers_copy_for_selected_text_outside_a_field_and_nothing_on_a_blank_part_of_the_app() {
    let selected = context_menu_template(
        &params(|p| p.selection_text = "hello".to_owned()),
        &APP_PAGE,
        false,
        en_text(),
    );
    assert_eq!(shape(&selected), ["copy"]);
    let blank = context_menu_template(
        &params(|p| p.selection_text = "  ".to_owned()),
        &APP_PAGE,
        false,
        en_text(),
    );
    assert!(blank.is_empty());
}

#[test]
fn copies_a_link_address_and_an_image() {
    let items = context_menu_template(
        &params(|p| {
            p.link_url = "https://example.com/a".to_owned();
            p.media_type = "image".to_owned();
            p.has_image_contents = true;
        }),
        &WEB_PAGE,
        false,
        en_text(),
    );
    assert_eq!(shape(&items), ["Copy Link Address", "-", "Copy Image"]);
    assert_eq!(
        action(&items[0]),
        &MenuAction::CopyLink("https://example.com/a".to_owned())
    );
    assert_eq!(action(&items[2]), &MenuAction::CopyImage { x: 10, y: 20 });
}

#[test]
fn opens_a_web_link_in_a_new_tab_where_the_page_offers_it_never_another_kind_of_link() {
    let text = zh_text();
    let items = context_menu_template(
        &params(|p| p.link_url = "https://example.com/a".to_owned()),
        &WEB_PAGE,
        true,
        text,
    );
    assert_eq!(
        labels(&items),
        [
            text["openLinkInNewTab"].as_str().unwrap(),
            text["copyLink"].as_str().unwrap(),
        ]
    );
    assert_eq!(
        action(&items[0]),
        &MenuAction::OpenLinkInNewTab {
            url: "https://example.com/a".to_owned(),
            referrer: Referrer {
                url: "https://site.example/".to_owned(),
                policy: "strict-origin-when-cross-origin".to_owned(),
            },
        }
    );
    let in_frame = context_menu_template(
        &params(|p| {
            p.link_url = "https://example.com/b".to_owned();
            p.frame_url = "https://frame.example/embed".to_owned();
            p.referrer_policy = "same-origin".to_owned();
        }),
        &WEB_PAGE,
        true,
        text,
    );
    assert_eq!(
        action(&in_frame[0]),
        &MenuAction::OpenLinkInNewTab {
            url: "https://example.com/b".to_owned(),
            referrer: Referrer {
                url: "https://frame.example/embed".to_owned(),
                policy: "same-origin".to_owned(),
            },
        }
    );
    for link_url in [
        "mailto:a@example.com",
        "javascript:alert(1)",
        "file:///etc/passwd",
    ] {
        let other = context_menu_template(
            &params(|p| p.link_url = link_url.to_owned()),
            &WEB_PAGE,
            true,
            en_text(),
        );
        assert_eq!(shape(&other), ["Copy Link Address"], "{link_url}");
    }
}

#[test]
fn labels_its_items_in_the_language_the_app_shows() {
    let text = zh_text();
    let items = context_menu_template(&params(|_| {}), &WEB_PAGE, false, text);
    assert_eq!(
        labels(&items),
        [
            text["back"].as_str().unwrap(),
            text["forward"].as_str().unwrap(),
            text["reload"].as_str().unwrap(),
        ]
    );
}

#[test]
fn offers_back_forward_and_reload_on_a_blank_part_of_a_web_page_only() {
    let items = context_menu_template(&params(|_| {}), &WEB_PAGE, false, en_text());
    assert_eq!(shape(&items), ["Back", "Forward (off)", "Reload"]);
    assert_eq!(action(&items[0]), &MenuAction::Back);
    assert_eq!(action(&items[1]), &MenuAction::Forward);
    assert_eq!(action(&items[2]), &MenuAction::Reload);
    let editable = context_menu_template(
        &params(|p| p.is_editable = true),
        &WEB_PAGE,
        false,
        en_text(),
    );
    assert!(!shape(&editable).contains(&"Reload".to_owned()));
    let selected = context_menu_template(
        &params(|p| p.selection_text = "x".to_owned()),
        &WEB_PAGE,
        false,
        en_text(),
    );
    assert_eq!(shape(&selected), ["copy"]);
}
