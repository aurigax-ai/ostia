#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

extern crate gpui_kit as gpui;

use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{AnyWindowHandle, AppContext as _, ElementId, Entity, TestAppContext, base::Root};
use ostia_app::shell::bridge::Bridge;
use ostia_app::shell::bridge::park::ParkBridge;
use ostia_app::shell::{
    ActiveView, Screen, ShellOptions, ShellRoot, Terminals, bind_shell_keys, open_shell_window,
};
use ostia_base::WorkspaceId;
use ostia_model::ids::IdNamespace;
use ostia_park::{ParkInput, ParkResult, ParkedStore};
use ostia_ui::theme::UiTheme as _;

struct Opened {
    handle: AnyWindowHandle,
    root: Entity<ShellRoot>,
    parked: ParkedStore,
    _data: tempfile::TempDir,
}

fn open(screen: Screen, cx: &mut TestAppContext) -> Opened {
    cx.update(|cx| {
        ostia_ui::init(cx);
        bind_shell_keys(cx);
    });
    let data = tempfile::tempdir().expect("temp folder");
    let parked = ParkedStore::new(data.path().join("parked-sessions.json"));
    let bridge = Bridge {
        park: ParkBridge::new(parked.clone()),
    };
    let root = cx.update(|cx| {
        open_shell_window(
            ShellOptions {
                screen,
                theme: None,
                terminals: Terminals::Off,
                namespace: IdNamespace::default(),
                bridge,
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
    Opened {
        handle,
        root,
        parked,
        _data: data,
    }
}

fn name(prefix: &str, id: &str) -> ElementId {
    ElementId::Name(format!("{prefix}-{id}").into())
}

fn click(opened: &Opened, id: impl Into<ElementId>, cx: &mut TestAppContext) {
    let id = id.into();
    cx.update_window(opened.handle, |_, window, cx| {
        window.render_frame(cx);
        window.click(id, cx);
    })
    .expect("window update");
    cx.run_until_parked();
}

fn exists(opened: &Opened, id: ElementId, cx: &mut TestAppContext) -> bool {
    cx.update_window(opened.handle, |_, window, cx| {
        window.render_frame(cx);
        window.try_find(id).is_some()
    })
    .expect("window update")
}

fn active_workspace(opened: &Opened, cx: &mut TestAppContext) -> Option<String> {
    opened.root.read_with(cx, |root, cx| {
        root.stores()
            .workspaces
            .read(cx)
            .state()
            .active_workspace_id()
            .map(str::to_owned)
    })
}

fn surface(opened: &Opened, pane: &str, cx: &mut TestAppContext) -> Option<gpui_kit::EntityId> {
    opened
        .root
        .read_with(cx, |root, cx| root.work_area().read(cx).surface_id(pane))
}

#[gpui_kit::test]
fn main_screen_lists_the_first_workspace_with_no_pane(cx: &mut TestAppContext) {
    let opened = open(Screen::Main, cx);
    cx.update_window(opened.handle, |_, window, cx| {
        window.render_frame(cx);
        assert_eq!(
            window.find(name("rail-workspace", "w1")).label(),
            Some("home")
        );
        assert!(window.try_find("empty-new-terminal").is_some());
    })
    .expect("window update");
}

#[gpui_kit::test]
fn new_workspace_adds_a_row_and_selects_it(cx: &mut TestAppContext) {
    let opened = open(Screen::Main, cx);
    click(&opened, "new-workspace", cx);
    assert!(exists(&opened, name("rail-workspace", "w2"), cx));
    assert_eq!(active_workspace(&opened, cx).as_deref(), Some("w2"));
}

#[gpui_kit::test]
fn selecting_a_row_changes_the_active_workspace(cx: &mut TestAppContext) {
    let opened = open(Screen::Main, cx);
    click(&opened, "new-workspace", cx);
    click(&opened, name("rail-workspace", "w1"), cx);
    assert_eq!(active_workspace(&opened, cx).as_deref(), Some("w1"));
}

#[gpui_kit::test]
fn closing_a_workspace_selects_its_neighbour_and_drops_its_surfaces(cx: &mut TestAppContext) {
    let opened = open(Screen::Main, cx);
    click(&opened, "new-workspace", cx);
    click(&opened, "empty-new-terminal", cx);
    assert!(surface(&opened, "pane-1", cx).is_some());
    click(&opened, name("rail-close", "w2"), cx);
    assert!(!exists(&opened, name("rail-workspace", "w2"), cx));
    assert_eq!(active_workspace(&opened, cx).as_deref(), Some("w1"));
    assert!(surface(&opened, "pane-1", cx).is_none());
}

#[gpui_kit::test]
fn closing_every_workspace_shows_the_no_workspaces_state(cx: &mut TestAppContext) {
    let opened = open(Screen::Main, cx);
    click(&opened, name("rail-close", "w1"), cx);
    assert_eq!(active_workspace(&opened, cx), None);
    assert!(exists(&opened, "empty-new-workspace".into(), cx));
}

#[gpui_kit::test]
fn the_empty_state_button_opens_a_pane_from_the_tree(cx: &mut TestAppContext) {
    let opened = open(Screen::Main, cx);
    click(&opened, "empty-new-terminal", cx);
    assert!(exists(&opened, name("pane-tab", "pane-1"), cx));
    assert!(surface(&opened, "pane-1", cx).is_some());
    assert!(!exists(&opened, "empty-new-terminal".into(), cx));
}

#[gpui_kit::test]
fn a_split_keeps_the_surface_of_the_first_pane(cx: &mut TestAppContext) {
    let opened = open(Screen::Main, cx);
    click(&opened, "empty-new-terminal", cx);
    let before = surface(&opened, "pane-1", cx);
    click(&opened, name("pane-split-right", "pane-1"), cx);
    assert!(exists(&opened, name("pane-tab", "pane-2"), cx));
    assert_eq!(surface(&opened, "pane-1", cx), before);
    click(&opened, name("pane-split-down", "pane-2"), cx);
    assert!(exists(&opened, name("pane-tab", "pane-3"), cx));
    assert_eq!(surface(&opened, "pane-1", cx), before);
}

#[gpui_kit::test]
fn a_new_tab_shows_in_the_slot_and_the_hidden_surface_stays(cx: &mut TestAppContext) {
    let opened = open(Screen::Main, cx);
    click(&opened, "empty-new-terminal", cx);
    let first = surface(&opened, "pane-1", cx);
    click(&opened, name("pane-new-terminal", "pane-1"), cx);
    assert!(exists(&opened, name("pane-tab", "pane-2"), cx));
    assert_eq!(surface(&opened, "pane-1", cx), first);
    click(&opened, name("pane-tab", "pane-1"), cx);
    assert_eq!(surface(&opened, "pane-1", cx), first);
    assert!(surface(&opened, "pane-2", cx).is_some());
}

#[gpui_kit::test]
fn closing_a_pane_removes_its_tab_and_surface(cx: &mut TestAppContext) {
    let opened = open(Screen::Main, cx);
    click(&opened, "empty-new-terminal", cx);
    click(&opened, name("pane-split-right", "pane-1"), cx);
    click(&opened, name("pane-close", "pane-2"), cx);
    assert!(!exists(&opened, name("pane-tab", "pane-2"), cx));
    assert!(surface(&opened, "pane-2", cx).is_none());
    assert!(surface(&opened, "pane-1", cx).is_some());
}

#[gpui_kit::test]
fn closing_the_last_pane_leaves_an_empty_workspace(cx: &mut TestAppContext) {
    let opened = open(Screen::Main, cx);
    click(&opened, "empty-new-terminal", cx);
    click(&opened, name("pane-close", "pane-1"), cx);
    assert!(exists(&opened, name("rail-workspace", "w1"), cx));
    assert!(exists(&opened, "empty-new-terminal".into(), cx));
}

#[gpui_kit::test]
fn switching_workspaces_keeps_the_surfaces_of_both(cx: &mut TestAppContext) {
    let opened = open(Screen::Main, cx);
    click(&opened, "empty-new-terminal", cx);
    let first = surface(&opened, "pane-1", cx);
    click(&opened, "new-workspace", cx);
    click(&opened, "empty-new-terminal", cx);
    assert!(!exists(&opened, name("pane-tab", "pane-1"), cx));
    click(&opened, name("rail-workspace", "w1"), cx);
    assert!(exists(&opened, name("pane-tab", "pane-1"), cx));
    assert_eq!(surface(&opened, "pane-1", cx), first);
    assert!(surface(&opened, "pane-2", cx).is_some());
}

#[gpui_kit::test]
fn the_park_bridge_shows_a_session_parked_in_the_core(cx: &mut TestAppContext) {
    let opened = open(Screen::Main, cx);
    assert!(!exists(&opened, "parked-sessions".into(), cx));
    let parked = opened
        .parked
        .park(ParkInput {
            workspace_id: WorkspaceId::new("w1"),
            resume: serde_json::json!({"agent": "claude", "id": "s1", "cwd": "/home/u/api"}),
            title: "api work".to_owned(),
            title_pinned: false,
            summary: None,
        })
        .expect("park");
    assert!(matches!(parked, ParkResult::Parked { .. }));
    cx.run_until_parked();
    cx.update_window(opened.handle, |_, window, cx| {
        window.render_frame(cx);
        assert_eq!(
            window.find("parked-sessions").label(),
            Some("1 parked session: api work")
        );
    })
    .expect("window update");
    opened.root.read_with(cx, |root, cx| {
        let records = root.work_area().read(cx).parked_in_active_workspace(cx);
        assert_eq!(records.len(), 1);
    });
}

#[gpui_kit::test]
fn the_sidebar_button_collapses_the_rail(cx: &mut TestAppContext) {
    let opened = open(Screen::Main, cx);
    click(&opened, "toggle-rail", cx);
    opened
        .root
        .read_with(cx, |root, _| assert!(root.rail_collapsed()));
}

#[gpui_kit::test]
fn the_settings_button_opens_settings(cx: &mut TestAppContext) {
    let opened = open(Screen::Main, cx);
    click(&opened, "open-settings", cx);
    opened.root.read_with(cx, |root, _| {
        assert_eq!(root.active_view(), ActiveView::Settings);
    });
}

#[gpui_kit::test]
fn settings_screen_shows_each_control_kind(cx: &mut TestAppContext) {
    let opened = open(Screen::Settings, cx);
    cx.update_window(opened.handle, |_, window, cx| {
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
    let _opened = open(Screen::Main, cx);
    cx.update(|cx| {
        let dark = cx.tokens().bg;
        ostia_ui::theme::set_theme("ostia-light", cx);
        assert_ne!(cx.tokens().bg, dark);
        assert_eq!(cx.ui_theme().scheme.id, "ostia-light");
    });
}
