use std::path::{Path, PathBuf};
use std::sync::{Arc, Weak};

use ostia_contract::attention::WorkspaceLiveState;
use parking_lot::Mutex;
use serde_json::Value;

pub const TRAY_ICON_SIZE: u32 = 22;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CloseAction {
    Close,
    Hide,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CloseState {
    pub quit_approved: bool,
    pub close_to_tray: bool,
    pub started_hidden: bool,
    pub manager_live: bool,
}

pub fn close_action(state: CloseState) -> CloseAction {
    if state.quit_approved {
        return CloseAction::Close;
    }
    if state.close_to_tray || state.started_hidden || state.manager_live {
        CloseAction::Hide
    } else {
        CloseAction::Close
    }
}

pub fn read_close_to_tray(settings: &Value) -> bool {
    !matches!(
        settings
            .get("workspaces")
            .and_then(|workspaces| workspaces.get("closeToTray")),
        Some(Value::Bool(false))
    )
}

pub fn is_hidden_launch(argv: &[String]) -> bool {
    argv.iter().any(|arg| arg == "--hidden")
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TrayText {
    pub show: String,
    pub quit: String,
    pub unread: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WindowPaneSummary {
    pub id: String,
    pub title: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WindowWorkspaceSummary {
    pub id: String,
    pub name: String,
    pub work_dir: String,
    pub state: WorkspaceLiveState,
    pub unread_at: i64,
    pub panes: Vec<WindowPaneSummary>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WindowSummary {
    pub window_id: String,
    pub detached: bool,
    pub workspaces: Vec<WindowWorkspaceSummary>,
}

pub fn unread_workspaces(list: &[WindowSummary]) -> usize {
    list.iter()
        .flat_map(|window| &window.workspaces)
        .filter(|workspace| {
            workspace.unread_at > 0 || workspace.state == WorkspaceLiveState::Waiting
        })
        .count()
}

pub fn tray_tooltip(base: &str, unread: i64, text: &TrayText) -> String {
    if unread <= 0 {
        return base.to_owned();
    }
    format!(
        "{base} · {}",
        text.unread.replace("{count}", &unread.to_string())
    )
}

pub trait TrayWindow: Send + Sync {
    fn is_destroyed(&self) -> bool;
    fn hide(&self);
    fn show(&self);
    fn focus(&self);
}

pub trait TrayIcon: Send {
    fn set_tooltip(&mut self, text: &str);
    fn destroy(&mut self);
}

pub type Callback = Arc<dyn Fn() + Send + Sync>;

#[derive(Clone)]
pub struct TraySpec {
    pub icon_size: u32,
    pub tooltip: String,
    pub show_label: String,
    pub quit_label: String,
    pub on_show: Callback,
    pub on_quit: Callback,
}

pub struct TrayDeps {
    pub icon_path: PathBuf,
    pub tooltip: String,
    pub text: Arc<dyn Fn() -> TrayText + Send + Sync>,
    pub windows: Arc<dyn Fn() -> Vec<Arc<dyn TrayWindow>> + Send + Sync>,
    pub quit: Callback,
    pub set_badge_count: Arc<dyn Fn(i64) + Send + Sync>,
    pub create_tray: Arc<dyn Fn(&Path, TraySpec) -> Box<dyn TrayIcon> + Send + Sync>,
}

#[derive(Default)]
struct TrayState {
    tray: Option<Box<dyn TrayIcon>>,
    unread: i64,
}

struct Shared {
    deps: TrayDeps,
    state: Mutex<TrayState>,
}

#[derive(Clone)]
pub struct AppTray {
    shared: Arc<Shared>,
}

impl AppTray {
    pub fn new(deps: TrayDeps) -> Self {
        Self {
            shared: Arc::new(Shared {
                deps,
                state: Mutex::new(TrayState::default()),
            }),
        }
    }

    pub fn created(&self) -> bool {
        self.shared.state.lock().tray.is_some()
    }

    pub fn hide(&self, window: &dyn TrayWindow) {
        window.hide();
        self.shared.ensure();
    }

    pub fn show_windows(&self) {
        self.shared.show_windows();
    }

    pub fn quit(&self) {
        self.shared.quit();
    }

    pub fn set_unread(&self, count: i64) {
        let labels = (self.shared.deps.text)();
        {
            let mut state = self.shared.state.lock();
            if count == state.unread {
                return;
            }
            state.unread = count;
        }
        (self.shared.deps.set_badge_count)(count);
        let mut state = self.shared.state.lock();
        if let Some(tray) = state.tray.as_mut() {
            tray.set_tooltip(&tray_tooltip(&self.shared.deps.tooltip, count, &labels));
        }
    }

    pub fn remove(&self) {
        let tray = self.shared.state.lock().tray.take();
        if let Some(mut tray) = tray {
            tray.destroy();
        }
    }
}

impl Shared {
    fn show_windows(&self) {
        for window in (self.deps.windows)() {
            if window.is_destroyed() {
                continue;
            }
            window.show();
            window.focus();
        }
    }

    fn quit(&self) {
        self.show_windows();
        (self.deps.quit)();
    }

    fn ensure(self: &Arc<Self>) {
        let mut state = self.state.lock();
        if state.tray.is_some() {
            return;
        }
        let labels = (self.deps.text)();
        let spec = TraySpec {
            icon_size: TRAY_ICON_SIZE,
            tooltip: tray_tooltip(&self.deps.tooltip, state.unread, &labels),
            show_label: labels.show,
            quit_label: labels.quit,
            on_show: Self::forward(self, Self::show_windows),
            on_quit: Self::forward(self, Self::quit),
        };
        state.tray = Some((self.deps.create_tray)(&self.deps.icon_path, spec));
    }

    fn forward(this: &Arc<Self>, action: fn(&Self)) -> Callback {
        let weak: Weak<Self> = Arc::downgrade(this);
        Arc::new(move || {
            if let Some(shared) = weak.upgrade() {
                action(&shared);
            }
        })
    }
}
