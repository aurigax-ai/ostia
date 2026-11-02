#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

extern crate gpui_kit as gpui;

use gpui_kit::prelude::*;
use gpui_kit::test::{TestQueryExt as _, TestWindowExt as _};
use gpui_kit::{Context, Render, Role, TestAppContext, Window, WindowOptions, div};
use ostia_ui::components::{Button, ListRow, SettingsList};

const LABEL: &str = "Patterns";
const EMPTY: &str = "No patterns.";
const ADD: &str = "Add";

struct Harness {
    rows: Vec<&'static str>,
    with_add: bool,
}

impl Render for Harness {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        let list = SettingsList::new("patterns", LABEL, EMPTY)
            .children(self.rows.iter().map(|title| ListRow::new(*title)))
            .when(self.with_add, |list| {
                list.add_row(Button::new(ADD).label(ADD))
            });
        div().size_full().child(list)
    }
}

fn check(
    cx: &mut TestAppContext,
    rows: Vec<&'static str>,
    with_add: bool,
    run: impl FnOnce(&mut Window, &mut gpui_kit::App),
) {
    cx.update(ostia_ui::init);
    let (handle, _) = cx.update(|cx| {
        gpui_kit::open_window(WindowOptions::default(), cx, move |_, cx| {
            cx.new(|_| Harness { rows, with_add })
        })
        .expect("window")
    });
    cx.update_window(handle, |_, window, cx| {
        window.render_frame(cx);
        run(window, cx);
    })
    .expect("window update");
}

#[gpui_kit::test]
fn names_the_list_and_holds_its_rows(cx: &mut TestAppContext) {
    check(cx, vec!["a", "b"], false, |window, _| {
        assert_eq!(window.find_by_label(LABEL).role(), Some(Role::List));
        assert_eq!(window.find_all_by_role(Role::ListItem).len(), 2);
        assert!(window.try_find_by_label(EMPTY).is_none());
    });
}

#[gpui_kit::test]
fn shows_one_muted_line_and_no_list_when_there_are_no_rows(cx: &mut TestAppContext) {
    check(cx, Vec::new(), false, |window, _| {
        assert!(window.try_find_by_label(EMPTY).is_some());
        assert!(window.find_all_by_role(Role::List).is_empty());
    });
}

#[gpui_kit::test]
fn treats_an_empty_array_of_rows_as_empty(cx: &mut TestAppContext) {
    check(cx, Vec::new(), false, |window, _| {
        assert!(window.try_find_by_label(EMPTY).is_some());
        assert!(window.find_all_by_role(Role::ListItem).is_empty());
    });
}

#[gpui_kit::test]
fn puts_the_add_row_after_the_list_also_when_the_list_is_empty(cx: &mut TestAppContext) {
    check(cx, vec!["a"], true, |window, _| {
        let list = window.find_by_label(LABEL).bounds();
        let add = window.find(ADD).bounds();
        assert!(add.origin.y >= list.origin.y + list.size.height);
    });
    check(cx, Vec::new(), true, |window, _| {
        assert!(window.try_find(ADD).is_some());
    });
}
