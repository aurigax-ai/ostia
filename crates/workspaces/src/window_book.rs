use std::collections::{HashMap, HashSet};

use serde_json::Value;

use crate::js_text::js_round;
use crate::workspace_snapshot::model::{
    AppSnapshot, DetachedBounds, PanePlacement, SnapshotWindow, SnapshotWorkspace, WindowBounds,
    WorkspaceOrigin,
};

pub const MAIN_SLOT: &str = "main";
pub const LANDING_CLAIM_MS: i64 = 3000;
pub const LANDING_GIVE_MS: i64 = 60_000;

const POINT_MAX: f64 = 100_000.0;
const GRAB_OFFSET_X: i64 = 120;
const GRAB_OFFSET_Y: i64 = 16;

#[derive(Clone, Debug, PartialEq)]
pub struct DetachedSlot {
    pub id: String,
    pub bounds: WindowBounds,
    pub snapshot: AppSnapshot,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ScreenPoint {
    pub x: i64,
    pub y: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WindowSize {
    pub width: i64,
    pub height: i64,
}

pub struct SplitSnapshot {
    pub main: Option<AppSnapshot>,
    pub detached: Vec<DetachedSlot>,
}

fn empty_snapshot(saved_at: &str) -> AppSnapshot {
    AppSnapshot {
        v: 1,
        saved_at: saved_at.to_owned(),
        active_workspace_id: None,
        workspaces: Vec::new(),
        groups: Vec::new(),
        left_panel: None,
        right_panel: None,
        bounds: None,
        detached_bounds: None,
        windows: Vec::new(),
    }
}

fn without_workspace(snapshot: &AppSnapshot, workspace_id: &str) -> AppSnapshot {
    if !snapshot
        .workspaces
        .iter()
        .any(|workspace| workspace.id == workspace_id)
    {
        return snapshot.clone();
    }
    let workspaces: Vec<SnapshotWorkspace> = snapshot
        .workspaces
        .iter()
        .filter(|workspace| workspace.id != workspace_id)
        .cloned()
        .collect();
    let active_workspace_id = if snapshot.active_workspace_id.as_deref() == Some(workspace_id) {
        workspaces.first().map(|workspace| workspace.id.clone())
    } else {
        snapshot.active_workspace_id.clone()
    };
    let groups = snapshot
        .groups
        .iter()
        .filter(|group| {
            workspaces
                .iter()
                .any(|workspace| workspace.group_id.as_deref() == Some(group.id.as_str()))
        })
        .cloned()
        .collect();
    AppSnapshot {
        active_workspace_id,
        workspaces,
        groups,
        ..snapshot.clone()
    }
}

fn without_group(workspace: &SnapshotWorkspace) -> SnapshotWorkspace {
    SnapshotWorkspace {
        group_id: None,
        ..workspace.clone()
    }
}

fn with_workspace(snapshot: &AppSnapshot, workspace: &SnapshotWorkspace) -> AppSnapshot {
    let base = without_workspace(snapshot, &workspace.id);
    let mut workspaces = base.workspaces.clone();
    workspaces.push(without_group(workspace));
    AppSnapshot {
        active_workspace_id: Some(workspace.id.clone()),
        workspaces,
        ..base
    }
}

pub fn split_snapshot(file: Option<&AppSnapshot>) -> SplitSnapshot {
    let Some(file) = file else {
        return SplitSnapshot {
            main: None,
            detached: Vec::new(),
        };
    };
    let main = AppSnapshot {
        windows: Vec::new(),
        ..file.clone()
    };
    let detached = file
        .windows
        .iter()
        .map(|window| DetachedSlot {
            id: window.id.clone(),
            bounds: window.bounds,
            snapshot: AppSnapshot {
                active_workspace_id: window.active_workspace_id.clone(),
                left_panel: window.left_panel,
                right_panel: window.right_panel.clone(),
                workspaces: window.workspaces.clone(),
                ..empty_snapshot(&file.saved_at)
            },
        })
        .collect();
    SplitSnapshot {
        main: Some(main),
        detached,
    }
}

pub fn merge_snapshots(
    main: Option<&AppSnapshot>,
    detached: &[DetachedSlot],
    saved_at: &str,
) -> AppSnapshot {
    let base = main.cloned().unwrap_or_else(|| empty_snapshot(saved_at));
    let windows = detached
        .iter()
        .filter(|slot| !slot.snapshot.workspaces.is_empty())
        .map(|slot| SnapshotWindow {
            id: slot.id.clone(),
            bounds: slot.bounds,
            active_workspace_id: slot.snapshot.active_workspace_id.clone(),
            left_panel: slot.snapshot.left_panel,
            right_panel: slot.snapshot.right_panel.clone(),
            workspaces: slot.snapshot.workspaces.clone(),
        })
        .collect();
    AppSnapshot {
        saved_at: saved_at.to_owned(),
        windows,
        ..base
    }
}

fn overlap(a: WindowBounds, b: WindowBounds) -> i64 {
    let width = (a.x + a.width).min(b.x + b.width) - a.x.max(b.x);
    let height = (a.y + a.height).min(b.y + b.height) - a.y.max(b.y);
    if width > 0 && height > 0 {
        width * height
    } else {
        0
    }
}

pub fn clamp_bounds(bounds: WindowBounds, areas: &[WindowBounds]) -> WindowBounds {
    let Some(first) = areas.first() else {
        return bounds;
    };
    let mut area = *first;
    let mut best = 0;
    for candidate in areas {
        let shared = overlap(bounds, *candidate);
        if shared > best {
            best = shared;
            area = *candidate;
        }
    }
    let width = bounds.width.min(area.width);
    let height = bounds.height.min(area.height);
    WindowBounds {
        x: bounds.x.max(area.x).min(area.x + area.width - width),
        y: bounds.y.max(area.y).min(area.y + area.height - height),
        width,
        height,
    }
}

pub fn parse_point(raw: &Value) -> Option<ScreenPoint> {
    let record = raw.as_object()?;
    let coordinate = |key: &str| {
        record
            .get(key)
            .and_then(Value::as_f64)
            .filter(|n| n.is_finite() && n.abs() <= POINT_MAX)
    };
    let x = coordinate("x")?;
    let y = coordinate("y")?;
    Some(ScreenPoint {
        x: js_round(x) as i64,
        y: js_round(y) as i64,
    })
}

pub fn bounds_at(point: ScreenPoint, size: WindowSize, areas: &[WindowBounds]) -> WindowBounds {
    let bounds = WindowBounds {
        x: point.x - GRAB_OFFSET_X,
        y: point.y - GRAB_OFFSET_Y,
        width: size.width,
        height: size.height,
    };
    let home = areas.iter().find(|area| {
        point.x >= area.x
            && point.x < area.x + area.width
            && point.y >= area.y
            && point.y < area.y + area.height
    });
    match home {
        Some(area) => clamp_bounds(bounds, &[*area]),
        None => clamp_bounds(bounds, areas),
    }
}

pub fn without_origin(workspace: SnapshotWorkspace) -> SnapshotWorkspace {
    SnapshotWorkspace {
        origin: None,
        ..workspace
    }
}

pub fn crosses_sandbox(
    pane_workspaces: &[Option<&str>],
    destination: &str,
    is_sandboxed: impl Fn(&str) -> bool,
) -> bool {
    pane_workspaces.iter().any(|from| match from {
        Some(from) => {
            !from.is_empty()
                && *from != destination
                && (is_sandboxed(*from) || is_sandboxed(destination))
        }
        None => false,
    })
}

#[derive(Clone, Debug, PartialEq)]
pub struct ReturnPlan {
    pub window_id: String,
    pub workspace: SnapshotWorkspace,
}

pub fn plan_return(
    workspace: &SnapshotWorkspace,
    source_window_id: &str,
    main_window_id: &str,
    owner_of: impl Fn(&str) -> Option<String>,
    is_sandboxed: impl Fn(&str) -> bool,
) -> ReturnPlan {
    let origin = workspace.origin.as_ref();
    let home = origin
        .filter(|origin| origin.workspace_id != workspace.id)
        .map(|origin| origin.workspace_id.as_str())
        .filter(|home| !home.is_empty());
    let owner = home.and_then(&owner_of).filter(|owner| !owner.is_empty());
    if let (Some(home), Some(owner)) = (home, owner)
        && owner != source_window_id
        && !crosses_sandbox(&[Some(workspace.id.as_str())], home, &is_sandboxed)
    {
        return ReturnPlan {
            window_id: owner,
            workspace: workspace.clone(),
        };
    }
    let Some(origin) = origin else {
        return ReturnPlan {
            window_id: main_window_id.to_owned(),
            workspace: workspace.clone(),
        };
    };
    let origin_here = WorkspaceOrigin {
        workspace_id: workspace.id.clone(),
        index: origin.index,
        group_id: origin.group_id.clone().filter(|group| !group.is_empty()),
        beside: None,
    };
    ReturnPlan {
        window_id: main_window_id.to_owned(),
        workspace: SnapshotWorkspace {
            origin: Some(origin_here),
            ..workspace.clone()
        },
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Landing {
    pub window_id: String,
    pub workspace_id: String,
    pub placement: PanePlacement,
}

struct LandingEntry {
    landing: Landing,
    at: i64,
    claimed_at: Option<i64>,
}

#[derive(Default)]
pub struct Landings {
    entries: HashMap<String, LandingEntry>,
}

impl Landings {
    pub fn record(&mut self, pane_id: &str, landing: Landing, now: i64) {
        self.entries.insert(
            pane_id.to_owned(),
            LandingEntry {
                landing,
                at: now,
                claimed_at: None,
            },
        );
    }

    fn live(&mut self, pane_id: &str, now: i64) -> Option<&mut LandingEntry> {
        let entry = self.entries.get(pane_id)?;
        let expired = match entry.claimed_at {
            Some(claimed_at) if claimed_at != 0 => now - claimed_at > LANDING_GIVE_MS,
            _ => now - entry.at > LANDING_CLAIM_MS,
        };
        if expired {
            self.entries.remove(pane_id);
            return None;
        }
        self.entries.get_mut(pane_id)
    }

    pub fn pending(&mut self, pane_id: &str, now: i64) -> bool {
        self.live(pane_id, now)
            .is_some_and(|entry| entry.claimed_at.is_none())
    }

    pub fn claim(&mut self, pane_id: &str, now: i64) -> bool {
        match self.live(pane_id, now) {
            Some(entry) if entry.claimed_at.is_none() => {
                entry.claimed_at = Some(now);
                true
            }
            _ => false,
        }
    }

    pub fn take(&mut self, pane_id: &str, now: i64) -> Option<Landing> {
        let claimed = self.live(pane_id, now)?.claimed_at.is_some();
        if !claimed {
            return None;
        }
        self.entries.remove(pane_id).map(|entry| entry.landing)
    }
}

fn without_bounds(snapshot: &AppSnapshot) -> AppSnapshot {
    AppSnapshot {
        bounds: None,
        detached_bounds: None,
        windows: Vec::new(),
        ..snapshot.clone()
    }
}

pub struct WindowBook {
    main: Option<AppSnapshot>,
    main_bounds: Option<WindowBounds>,
    detached: Vec<DetachedSlot>,
    last_detached: Vec<(String, WindowBounds)>,
}

impl WindowBook {
    pub fn new(file: Option<&AppSnapshot>) -> Self {
        let split = split_snapshot(file);
        let main_bounds = split.main.as_ref().and_then(|main| main.bounds);
        let mut last_detached: Vec<(String, WindowBounds)> = Vec::new();
        if let Some(DetachedBounds(entries)) = split
            .main
            .as_ref()
            .and_then(|main| main.detached_bounds.as_ref())
        {
            for (id, bounds) in entries {
                set_last(&mut last_detached, id, *bounds);
            }
        }
        let mut detached: Vec<DetachedSlot> = Vec::new();
        for slot in split.detached {
            put_slot(&mut detached, slot);
        }
        Self {
            main: split.main.as_ref().map(without_bounds),
            main_bounds,
            detached,
            last_detached,
        }
    }

    pub fn last_detached_bounds(&self, workspace_id: &str) -> Option<WindowBounds> {
        self.last_detached
            .iter()
            .find(|(id, _)| id == workspace_id)
            .map(|(_, bounds)| *bounds)
    }

    pub fn bounds_of(&self, slot: &str) -> Option<WindowBounds> {
        if slot == MAIN_SLOT {
            return self.main_bounds;
        }
        self.find(slot).map(|entry| entry.bounds)
    }

    pub fn slots(&self) -> Vec<DetachedSlot> {
        self.detached.clone()
    }

    pub fn load(&self, slot: &str) -> Option<&AppSnapshot> {
        if slot == MAIN_SLOT {
            return self.main.as_ref();
        }
        self.find(slot).map(|entry| &entry.snapshot)
    }

    pub fn save(&mut self, slot: &str, snapshot: AppSnapshot) {
        if slot == MAIN_SLOT {
            self.main = Some(without_bounds(&snapshot));
            return;
        }
        if let Some(entry) = self.find_mut(slot) {
            entry.snapshot = AppSnapshot {
                groups: Vec::new(),
                ..snapshot
            };
        }
    }

    pub fn set_bounds(&mut self, slot: &str, bounds: WindowBounds) {
        if slot == MAIN_SLOT {
            self.main_bounds = Some(bounds);
            return;
        }
        if let Some(entry) = self.find_mut(slot) {
            entry.bounds = bounds;
        }
    }

    pub fn open(&mut self, slot: &str, bounds: WindowBounds) {
        put_slot(
            &mut self.detached,
            DetachedSlot {
                id: slot.to_owned(),
                bounds,
                snapshot: empty_snapshot(""),
            },
        );
    }

    pub fn drop_slot(&mut self, slot: &str) {
        self.detached.retain(|entry| entry.id != slot);
    }

    pub fn move_workspace(&mut self, workspace: &SnapshotWorkspace, from: &str, to: &str) {
        let left = if from == MAIN_SLOT {
            None
        } else {
            self.bounds_of(from)
        };
        if let Some(left) = left {
            set_last(&mut self.last_detached, &workspace.id, left);
        }
        if let Some(source) = self
            .load(from)
            .map(|source| without_workspace(source, &workspace.id))
        {
            self.save(from, source);
        }
        let target = self
            .load(to)
            .map_or_else(|| empty_snapshot(""), AppSnapshot::clone);
        self.save(to, with_workspace(&target, workspace));
    }

    pub fn merged(&self, saved_at: &str) -> AppSnapshot {
        let merged = merge_snapshots(self.main.as_ref(), &self.detached, saved_at);
        let ids: HashSet<&str> = merged
            .workspaces
            .iter()
            .chain(merged.windows.iter().flat_map(|window| &window.workspaces))
            .map(|workspace| workspace.id.as_str())
            .collect();
        let detached_bounds: Vec<(String, WindowBounds)> = self
            .last_detached
            .iter()
            .filter(|(id, _)| ids.contains(id.as_str()))
            .cloned()
            .collect();
        let detached_bounds =
            (!detached_bounds.is_empty()).then_some(DetachedBounds(detached_bounds));
        AppSnapshot {
            bounds: self.main_bounds,
            detached_bounds,
            ..merged
        }
    }

    fn find(&self, slot: &str) -> Option<&DetachedSlot> {
        self.detached.iter().find(|entry| entry.id == slot)
    }

    fn find_mut(&mut self, slot: &str) -> Option<&mut DetachedSlot> {
        self.detached.iter_mut().find(|entry| entry.id == slot)
    }
}

fn put_slot(slots: &mut Vec<DetachedSlot>, slot: DetachedSlot) {
    match slots.iter_mut().find(|entry| entry.id == slot.id) {
        Some(existing) => *existing = slot,
        None => slots.push(slot),
    }
}

fn set_last(entries: &mut Vec<(String, WindowBounds)>, id: &str, bounds: WindowBounds) {
    match entries.iter_mut().find(|(key, _)| key == id) {
        Some(entry) => entry.1 = bounds,
        None => entries.push((id.to_owned(), bounds)),
    }
}
