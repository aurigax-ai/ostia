#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

extern crate gpui_kit as gpui;

use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{AnyWindowHandle, AppContext as _, Entity, TestAppContext, base::Root};
use ostia_app::shell::{
    Screen, ShellOptions, ShellRoot, Terminals, bind_shell_keys, fixture_workspaces,
    open_shell_window,
};
use ostia_ui::theme::UiTheme as _;

fn open(screen: Screen, cx: &mut TestAppContext) -> (AnyWindowHandle, Entity<ShellRoot>) {
    cx.update(|cx| {
        ostia_ui::init(cx);
        bind_shell_keys(cx);
    });
    let root = cx.update(|cx| {
        open_shell_window(
            ShellOptions {
                screen,
                theme: None,
                terminals: Terminals::Off,
            },
            cx,
        )
        .expect("window")
    });
    let handle = cx.update(|cx| {
        cx.windows()
            .into_iter()
            .find(|window| window.downcast::<Root>().is_some())
            .expect("root window")
    });
    cx.run_until_parked();
    (handle, root)
}

#[gpui_kit::test]
fn main_screen_lists_the_live_row_and_every_fixture(cx: &mut TestAppContext) {
    let (handle, _root) = open(Screen::Main, cx);
    cx.update_window(handle, |_, window, cx| {
        window.render_frame(cx);
        assert_eq!(window.find("rail-live").label(), Some("Live shells"));
        assert_eq!(fixture_workspaces().len(), 4);
        for (index, fixture) in fixture_workspaces().iter().enumerate() {
            let id = gpui_kit::ElementId::NamedInteger("rail-fixture".into(), index as u64);
            assert_eq!(window.find(id).label(), Some(fixture.title));
        }
    })
    .expect("window update");
}

#[gpui_kit::test]
fn selecting_a_fixture_row_changes_the_view(cx: &mut TestAppContext) {
    let (handle, root) = open(Screen::Main, cx);
    cx.update_window(handle, |_, window, cx| {
        window.render_frame(cx);
        window.click(
            gpui_kit::ElementId::NamedInteger("rail-fixture".into(), 1),
            cx,
        );
    })
    .expect("window update");
    root.read_with(cx, |root, _| {
        assert_eq!(format!("{:?}", root.active_view()), "Fixture(1)");
    });
}

#[gpui_kit::test]
fn the_sidebar_button_collapses_the_rail(cx: &mut TestAppContext) {
    let (handle, root) = open(Screen::Main, cx);
    cx.update_window(handle, |_, window, cx| {
        window.render_frame(cx);
        window.click("toggle-rail", cx);
    })
    .expect("window update");
    root.read_with(cx, |root, _| assert!(root.rail_collapsed()));
}

#[gpui_kit::test]
fn the_settings_button_opens_settings(cx: &mut TestAppContext) {
    let (handle, root) = open(Screen::Main, cx);
    cx.update_window(handle, |_, window, cx| {
        window.render_frame(cx);
        window.click("open-settings", cx);
    })
    .expect("window update");
    root.read_with(cx, |root, _| {
        assert_eq!(format!("{:?}", root.active_view()), "Settings");
    });
}

#[gpui_kit::test]
fn settings_screen_shows_each_control_kind(cx: &mut TestAppContext) {
    let (handle, _root) = open(Screen::Settings, cx);
    cx.update_window(handle, |_, window, cx| {
        window.render_frame(cx);
        for id in [
            "fixture-switch",
            "fixture-outline",
            "fixture-primary",
            "fixture-dialog",
            "fixture-reset",
        ] {
            assert!(window.try_find(id).is_some(), "{id} is missing");
        }
    })
    .expect("window update");
}

#[gpui_kit::test]
fn set_theme_changes_the_tokens_every_screen_reads(cx: &mut TestAppContext) {
    let (_handle, _root) = open(Screen::Main, cx);
    cx.update(|cx| {
        let dark = cx.tokens().bg;
        ostia_ui::theme::set_theme("ostia-light", cx);
        assert_ne!(cx.tokens().bg, dark);
        assert_eq!(cx.ui_theme().scheme.id, "ostia-light");
    });
}

#[gpui_kit::test]
fn panes_without_terminals_keep_the_split_and_the_tabs(cx: &mut TestAppContext) {
    let (handle, _root) = open(Screen::Main, cx);
    cx.update_window(handle, |_, window, cx| {
        window.render_frame(cx);
        for index in 0..2 {
            let id = gpui_kit::ElementId::NamedInteger("pane-tab".into(), index);
            assert!(window.try_find(id).is_some(), "pane {index} is missing");
        }
    })
    .expect("window update");
}
