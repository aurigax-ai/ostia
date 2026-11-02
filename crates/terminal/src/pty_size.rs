use ostia_base::PaneId;

pub trait SizedPty {
    fn cols(&self) -> u16;
    fn rows(&self) -> u16;
    fn resize(&mut self, cols: u16, rows: u16) -> Result<(), String>;
}

pub trait ScreenMirror {
    fn resize(&mut self, cols: u16, rows: u16);
}

pub trait SizeWindow {
    fn is_destroyed(&self) -> bool;
    fn send_size(&self, pane_id: &PaneId, cols: u16, rows: u16, held: bool);
}

type SizeListener = Box<dyn Fn(u16, u16)>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PtyHold {
    pub holder: String,
    pub desktop_cols: u16,
    pub desktop_rows: u16,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HoldOutcome {
    Ok,
    HeldByOther,
}

pub struct PtySizeEntry {
    pty: Box<dyn SizedPty>,
    mirror: Box<dyn ScreenMirror>,
    windows: Vec<(String, Box<dyn SizeWindow>)>,
    size_listeners: Vec<SizeListener>,
    hold: Option<PtyHold>,
}

impl PtySizeEntry {
    pub fn new(pty: Box<dyn SizedPty>, mirror: Box<dyn ScreenMirror>) -> Self {
        Self {
            pty,
            mirror,
            windows: Vec::new(),
            size_listeners: Vec::new(),
            hold: None,
        }
    }

    pub fn add_window(&mut self, id: String, window: Box<dyn SizeWindow>) {
        match self.windows.iter_mut().find(|(key, _)| *key == id) {
            Some(slot) => slot.1 = window,
            None => self.windows.push((id, window)),
        }
    }

    pub fn add_size_listener(&mut self, listener: SizeListener) {
        self.size_listeners.push(listener);
    }

    pub fn hold(&self) -> Option<&PtyHold> {
        self.hold.as_ref()
    }
}

fn fallback_size(cols: u16, rows: u16) -> (u16, u16) {
    (
        if cols == 0 { 80 } else { cols },
        if rows == 0 { 24 } else { rows },
    )
}

fn tell_windows(pane_id: &PaneId, entry: &PtySizeEntry, cols: u16, rows: u16, held: bool) {
    for (_, window) in &entry.windows {
        if !window.is_destroyed() {
            window.send_size(pane_id, cols, rows, held);
        }
    }
}

pub fn resize_pty(entry: Option<&mut PtySizeEntry>, cols: u16, rows: u16) {
    let Some(entry) = entry else { return };
    let (cols, rows) = fallback_size(cols, rows);
    let changed = entry.pty.cols() != cols || entry.pty.rows() != rows;
    if entry.pty.resize(cols, rows).is_err() {
        return;
    }
    entry.mirror.resize(cols, rows);
    if changed {
        for listener in &entry.size_listeners {
            listener(cols, rows);
        }
    }
}

pub fn resize_for_all(pane_id: &PaneId, entry: &mut PtySizeEntry, cols: u16, rows: u16) {
    if entry.pty.cols() == cols && entry.pty.rows() == rows {
        return;
    }
    resize_pty(Some(&mut *entry), cols, rows);
    let held = entry.hold.is_some();
    tell_windows(pane_id, entry, cols, rows, held);
}

pub fn hold_pty(
    pane_id: &PaneId,
    entry: &mut PtySizeEntry,
    holder: &str,
    cols: u16,
    rows: u16,
) -> HoldOutcome {
    if entry
        .hold
        .as_ref()
        .is_some_and(|hold| hold.holder != holder)
    {
        return HoldOutcome::HeldByOther;
    }
    if entry.hold.is_none() {
        entry.hold = Some(PtyHold {
            holder: holder.to_owned(),
            desktop_cols: entry.pty.cols(),
            desktop_rows: entry.pty.rows(),
        });
    }
    resize_pty(Some(&mut *entry), cols, rows);
    tell_windows(pane_id, entry, cols, rows, true);
    HoldOutcome::Ok
}

pub fn release_pty(pane_id: &PaneId, entry: &mut PtySizeEntry, holder: Option<&str>) {
    let Some(hold) = entry.hold.as_ref() else {
        return;
    };
    if holder.is_some_and(|name| hold.holder != name) {
        return;
    }
    let (cols, rows) = (hold.desktop_cols, hold.desktop_rows);
    entry.hold = None;
    resize_pty(Some(&mut *entry), cols, rows);
    tell_windows(pane_id, entry, cols, rows, false);
}

pub fn resize_from_desktop(pane_id: &PaneId, entry: &mut PtySizeEntry, cols: u16, rows: u16) {
    let held = entry.hold.take().is_some();
    resize_pty(Some(&mut *entry), cols, rows);
    if held {
        let (cols, rows) = fallback_size(cols, rows);
        tell_windows(pane_id, entry, cols, rows, false);
    }
}
