use std::sync::Arc;

use ostia_contract::global_hotkey::to_accelerator;
use serde_json::Value;

pub type ShortcutCallback = Arc<dyn Fn() + Send + Sync>;

pub trait ShortcutRegistry: Send + Sync {
    fn register(&self, accelerator: &str, callback: ShortcutCallback) -> bool;
    fn unregister(&self, accelerator: &str);
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HotkeyStatus {
    Off,
    Registered,
    Taken,
}

pub struct GlobalHotkey {
    registry: Arc<dyn ShortcutRegistry>,
    toggle: ShortcutCallback,
    current: Option<String>,
}

impl GlobalHotkey {
    pub fn new(registry: Arc<dyn ShortcutRegistry>, toggle: ShortcutCallback) -> Self {
        Self {
            registry,
            toggle,
            current: None,
        }
    }

    pub fn apply(&mut self, setting: &Value) -> HotkeyStatus {
        let next = to_accelerator(setting);
        if next == self.current {
            return if next.is_some() {
                HotkeyStatus::Registered
            } else {
                HotkeyStatus::Off
            };
        }
        self.clear();
        let Some(next) = next else {
            return HotkeyStatus::Off;
        };
        if !self.registry.register(&next, Arc::clone(&self.toggle)) {
            return HotkeyStatus::Taken;
        }
        self.current = Some(next);
        HotkeyStatus::Registered
    }

    pub fn clear(&mut self) {
        if let Some(current) = self.current.take() {
            self.registry.unregister(&current);
        }
    }
}

pub trait ToggleWindow {
    fn is_visible(&self) -> bool;
    fn is_focused(&self) -> bool;
    fn is_destroyed(&self) -> bool;
}

pub fn should_hide_windows<W: ToggleWindow>(windows: &[W]) -> bool {
    windows
        .iter()
        .any(|w| !w.is_destroyed() && w.is_visible() && w.is_focused())
}

pub trait ToggleTray<W> {
    fn hide(&self, win: &W);
}

pub fn toggle_windows<W: ToggleWindow>(
    windows: &[W],
    tray: Option<&dyn ToggleTray<W>>,
    reveal: impl FnOnce(),
) {
    let Some(tray) = tray.filter(|_| should_hide_windows(windows)) else {
        reveal();
        return;
    };
    for win in windows {
        if !win.is_destroyed() && win.is_visible() {
            tray.hide(win);
        }
    }
}
