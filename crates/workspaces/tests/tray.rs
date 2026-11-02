#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::{Path, PathBuf};
use std::sync::Arc;

use ostia_contract::attention::WorkspaceLiveState;
use ostia_workspaces::tray::{
    AppTray, CloseAction, CloseState, TrayDeps, TrayIcon, TraySpec, TrayText, TrayWindow,
    WindowPaneSummary, WindowSummary, WindowWorkspaceSummary, close_action, is_hidden_launch,
    read_close_to_tray, tray_tooltip, unread_workspaces,
};
use parking_lot::Mutex;
use serde_json::json;

fn en() -> TrayText {
    TrayText {
        show: "Show".to_owned(),
        quit: "Quit".to_owned(),
        unread: "{count} unread".to_owned(),
    }
}

fn zh_hant() -> TrayText {
    TrayText {
        show: "顯示".to_owned(),
        quit: "結束".to_owned(),
        unread: "{count} 則未讀".to_owned(),
    }
}

#[derive(Default)]
struct IconState {
    destroyed: bool,
    tooltip: String,
}

struct FakeIcon(Arc<Mutex<IconState>>);

impl TrayIcon for FakeIcon {
    fn set_tooltip(&mut self, text: &str) {
        self.0.lock().tooltip = text.to_owned();
    }

    fn destroy(&mut self) {
        self.0.lock().destroyed = true;
    }
}

struct CreatedTray {
    state: Arc<Mutex<IconState>>,
    spec: TraySpec,
    icon_path: PathBuf,
}

struct FakeWindow {
    events: Arc<Mutex<Vec<String>>>,
    destroyed: bool,
}

impl TrayWindow for FakeWindow {
    fn is_destroyed(&self) -> bool {
        self.destroyed
    }

    fn hide(&self) {
        self.events.lock().push("hide".to_owned());
    }

    fn show(&self) {
        self.events.lock().push("show".to_owned());
    }

    fn focus(&self) {
        self.events.lock().push("focus".to_owned());
    }
}

struct Rig {
    events: Arc<Mutex<Vec<String>>>,
    trays: Arc<Mutex<Vec<CreatedTray>>>,
    badges: Arc<Mutex<Vec<i64>>>,
    win: Arc<FakeWindow>,
    tray: AppTray,
}

fn rig() -> Rig {
    let events = Arc::new(Mutex::new(Vec::new()));
    let trays: Arc<Mutex<Vec<CreatedTray>>> = Arc::new(Mutex::new(Vec::new()));
    let badges = Arc::new(Mutex::new(Vec::new()));
    let win = Arc::new(FakeWindow {
        events: Arc::clone(&events),
        destroyed: false,
    });
    let listed: Arc<dyn TrayWindow> = win.clone();
    let quit_events = Arc::clone(&events);
    let badge_log = Arc::clone(&badges);
    let created = Arc::clone(&trays);
    let tray = AppTray::new(TrayDeps {
        icon_path: PathBuf::from("/icon.png"),
        tooltip: "Ostia".to_owned(),
        text: Arc::new(en),
        windows: Arc::new(move || vec![Arc::clone(&listed)]),
        quit: Arc::new(move || quit_events.lock().push("quit".to_owned())),
        set_badge_count: Arc::new(move |count| badge_log.lock().push(count)),
        create_tray: Arc::new(move |icon_path: &Path, spec: TraySpec| {
            let state = Arc::new(Mutex::new(IconState {
                destroyed: false,
                tooltip: spec.tooltip.clone(),
            }));
            created.lock().push(CreatedTray {
                state: Arc::clone(&state),
                spec,
                icon_path: icon_path.to_path_buf(),
            });
            Box::new(FakeIcon(state))
        }),
    });
    Rig {
        events,
        trays,
        badges,
        win,
        tray,
    }
}

impl Rig {
    fn events(&self) -> Vec<String> {
        self.events.lock().clone()
    }

    fn tray_count(&self) -> usize {
        self.trays.lock().len()
    }

    fn last_destroyed(&self) -> bool {
        self.trays.lock().last().unwrap().state.lock().destroyed
    }

    fn last_tooltip(&self) -> String {
        self.trays
            .lock()
            .last()
            .unwrap()
            .state
            .lock()
            .tooltip
            .clone()
    }

    fn click_show(&self) {
        let on_show = Arc::clone(&self.trays.lock().last().unwrap().spec.on_show);
        on_show();
    }

    fn click_quit(&self) {
        let on_quit = Arc::clone(&self.trays.lock().last().unwrap().spec.on_quit);
        on_quit();
    }
}

#[test]
fn mgr_c1_hides_the_window_and_shows_one_tray_icon() {
    let rig = rig();
    let before = rig.tray_count();
    rig.tray.hide(rig.win.as_ref());
    rig.tray.hide(rig.win.as_ref());
    assert_eq!(rig.events(), ["hide", "hide"]);
    assert_eq!(rig.tray_count(), before + 1);
    assert!(rig.tray.created());
}

#[test]
fn mgr_c3_show_brings_the_window_back_and_keeps_the_tray_icon() {
    let rig = rig();
    rig.tray.hide(rig.win.as_ref());
    assert_eq!(rig.trays.lock().last().unwrap().spec.show_label, "Show");
    rig.click_show();
    assert_eq!(rig.events(), ["hide", "show", "focus"]);
    assert!(!rig.last_destroyed());
    assert!(rig.tray.created());
}

#[test]
fn creates_one_tray_for_the_app_life_across_repeated_hide_and_show_cycles() {
    let rig = rig();
    let before = rig.tray_count();
    for _ in 0..3 {
        rig.tray.hide(rig.win.as_ref());
        rig.tray.show_windows();
    }
    rig.tray.hide(rig.win.as_ref());
    assert_eq!(rig.tray_count(), before + 1);
    assert!(!rig.last_destroyed());
}

#[test]
fn remove_destroys_the_tray_and_a_later_hide_creates_a_new_one() {
    let rig = rig();
    rig.tray.hide(rig.win.as_ref());
    rig.tray.remove();
    assert!(rig.last_destroyed());
    assert!(!rig.tray.created());
    rig.tray.hide(rig.win.as_ref());
    assert_eq!(rig.tray_count(), 2);
    assert!(!rig.last_destroyed());
    assert!(rig.tray.created());
}

#[test]
fn mgr_c4_quit_shows_the_window_before_quitting_so_the_close_guard_can_ask() {
    let rig = rig();
    rig.tray.hide(rig.win.as_ref());
    assert_eq!(rig.trays.lock().last().unwrap().spec.quit_label, "Quit");
    rig.click_quit();
    assert_eq!(rig.events(), ["hide", "show", "focus", "quit"]);
}

#[test]
fn builds_the_tray_from_the_icon_path_and_the_current_tooltip() {
    let rig = rig();
    rig.tray.set_unread(2);
    rig.tray.hide(rig.win.as_ref());
    let trays = rig.trays.lock();
    assert_eq!(trays[0].icon_path, Path::new("/icon.png"));
    assert_eq!(trays[0].spec.tooltip, "Ostia · 2 unread");
}

#[test]
fn show_windows_skips_a_destroyed_window() {
    let events = Arc::new(Mutex::new(Vec::new()));
    let gone: Arc<dyn TrayWindow> = Arc::new(FakeWindow {
        events: Arc::clone(&events),
        destroyed: true,
    });
    let alive: Arc<dyn TrayWindow> = Arc::new(FakeWindow {
        events: Arc::clone(&events),
        destroyed: false,
    });
    let listed = vec![gone, alive];
    let tray = AppTray::new(TrayDeps {
        icon_path: PathBuf::from("/icon.png"),
        tooltip: "Ostia".to_owned(),
        text: Arc::new(en),
        windows: Arc::new(move || listed.clone()),
        quit: Arc::new(|| {}),
        set_badge_count: Arc::new(|_| {}),
        create_tray: Arc::new(|_, spec: TraySpec| {
            Box::new(FakeIcon(Arc::new(Mutex::new(IconState {
                destroyed: false,
                tooltip: spec.tooltip,
            }))))
        }),
    });
    tray.show_windows();
    assert_eq!(*events.lock(), ["show", "focus"]);
}

fn ws(state: WorkspaceLiveState, unread_at: i64) -> WindowWorkspaceSummary {
    WindowWorkspaceSummary {
        id: "w".to_owned(),
        name: "w".to_owned(),
        work_dir: "/".to_owned(),
        state,
        unread_at,
        panes: Vec::<WindowPaneSummary>::new(),
    }
}

#[test]
fn counts_workspaces_with_an_unread_notification_or_a_waiting_agent_in_every_window() {
    let list = [
        WindowSummary {
            window_id: "1".to_owned(),
            detached: false,
            workspaces: vec![
                ws(WorkspaceLiveState::Idle, 5),
                ws(WorkspaceLiveState::Waiting, 0),
            ],
        },
        WindowSummary {
            window_id: "2".to_owned(),
            detached: true,
            workspaces: vec![
                ws(WorkspaceLiveState::Working, 0),
                ws(WorkspaceLiveState::Done, 9),
            ],
        },
    ];
    assert_eq!(unread_workspaces(&list), 3);
    assert_eq!(unread_workspaces(&[]), 0);
}

#[test]
fn puts_the_count_in_the_tray_tooltip_and_the_badge_and_drops_it_at_zero() {
    assert_eq!(tray_tooltip("Ostia", 0, &en()), "Ostia");
    assert_eq!(tray_tooltip("Ostia", 2, &en()), "Ostia · 2 unread");
    assert_eq!(tray_tooltip("Ostia", 2, &zh_hant()), "Ostia · 2 則未讀");
    let rig = rig();
    rig.tray.set_unread(3);
    rig.tray.hide(rig.win.as_ref());
    assert_eq!(rig.last_tooltip(), "Ostia · 3 unread");
    rig.tray.set_unread(0);
    assert_eq!(rig.last_tooltip(), "Ostia");
    assert_eq!(*rig.badges.lock(), [3, 0]);
}

#[test]
fn a_negative_count_shows_no_unread_text() {
    assert_eq!(tray_tooltip("Ostia", -1, &en()), "Ostia");
}

#[test]
fn an_unchanged_count_sets_no_badge() {
    let rig = rig();
    rig.tray.set_unread(0);
    rig.tray.set_unread(4);
    rig.tray.set_unread(4);
    assert_eq!(*rig.badges.lock(), [4]);
}

fn state(
    quit_approved: bool,
    close_to_tray: bool,
    started_hidden: bool,
    manager_live: bool,
) -> CloseState {
    CloseState {
        quit_approved,
        close_to_tray,
        started_hidden,
        manager_live,
    }
}

#[test]
fn mgr_c1_hides_the_window_when_close_to_tray_is_on() {
    assert_eq!(
        close_action(state(false, true, false, false)),
        CloseAction::Hide
    );
}

#[test]
fn mgr_c2_closes_the_window_when_close_to_tray_is_off() {
    assert_eq!(
        close_action(state(false, false, false, false)),
        CloseAction::Close
    );
}

#[test]
fn mgr_c1_hides_the_window_when_ostia_was_started_hidden_even_with_the_setting_off() {
    assert_eq!(
        close_action(state(false, false, true, false)),
        CloseAction::Hide
    );
}

#[test]
fn mgr_c6_closes_instead_of_hiding_once_a_quit_was_approved() {
    assert_eq!(
        close_action(state(true, true, true, true)),
        CloseAction::Close
    );
}

#[test]
fn mgr_c19_hides_the_window_while_a_manager_is_live_even_with_close_to_tray_off() {
    assert_eq!(
        close_action(state(false, false, false, true)),
        CloseAction::Hide
    );
}

#[test]
fn mgr_c1_reads_workspaces_close_to_tray_when_it_is_true() {
    assert!(read_close_to_tray(
        &json!({"workspaces": {"closeToTray": true}})
    ));
}

#[test]
fn mgr_c5_treats_missing_or_malformed_settings_as_on_the_default() {
    let rows = [
        json!(null),
        json!({}),
        json!({"workspaces": null}),
        json!({"workspaces": {"closeToTray": "yes"}}),
        json!({"workspaces": {"closeToTray": 1}}),
        json!("settings"),
        json!([]),
        json!({"workspaces": []}),
    ];
    for row in &rows {
        assert!(read_close_to_tray(row), "{row}");
    }
}

#[test]
fn mgr_c2_reads_workspaces_close_to_tray_when_the_human_turned_it_off() {
    assert!(!read_close_to_tray(
        &json!({"workspaces": {"closeToTray": false}})
    ));
}

#[test]
fn mgr_c41_mgr_c42_reveals_the_running_ostia_on_a_plain_second_launch_but_not_on_a_hidden_one() {
    assert!(!is_hidden_launch(&["/opt/ostia/ostia".to_owned()]));
    assert!(is_hidden_launch(&[
        "/opt/ostia/ostia".to_owned(),
        "--hidden".to_owned()
    ]));
}

#[test]
fn a_slow_badge_update_does_not_land_after_a_newer_one() {
    use std::sync::mpsc;
    use std::time::Duration;

    let badges: Arc<Mutex<Vec<i64>>> = Arc::new(Mutex::new(Vec::new()));
    let (entered, entered_rx) = mpsc::channel::<()>();
    let entered = Mutex::new(entered);
    let log = Arc::clone(&badges);
    let tray = AppTray::new(TrayDeps {
        icon_path: PathBuf::from("/icon.png"),
        tooltip: "Ostia".to_owned(),
        text: Arc::new(en),
        windows: Arc::new(Vec::<Arc<dyn TrayWindow>>::new),
        quit: Arc::new(|| {}),
        set_badge_count: Arc::new(move |count| {
            if count == 1 {
                entered.lock().send(()).unwrap();
                std::thread::sleep(Duration::from_millis(150));
            }
            log.lock().push(count);
        }),
        create_tray: Arc::new(|_: &Path, _: TraySpec| {
            Box::new(FakeIcon(Arc::new(Mutex::new(IconState::default()))))
        }),
    });
    let first = {
        let tray = tray.clone();
        std::thread::spawn(move || tray.set_unread(1))
    };
    entered_rx.recv().unwrap();
    tray.set_unread(2);
    first.join().unwrap();
    assert_eq!(badges.lock().clone(), vec![1, 2]);
}
