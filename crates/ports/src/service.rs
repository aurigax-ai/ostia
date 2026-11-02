use std::collections::{BTreeSet, HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use ostia_base::watched_refresher::{
    ReadFuture, RefreshSource, WatchedRefresher, WatchedRefresherOptions,
};
use ostia_contract::boards_ports::PortsSettings;
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::chips::{pane_chip_values, workspace_chip_values};
use crate::scan::scan_trees;
use crate::sidebar::{
    PaneRef, WorkspaceProcesses, group_by_workspace, sidebar_entries, terminal_pids,
};
use crate::{ListeningPort, TreeInfo};

const REFRESH_DEBOUNCE: Duration = Duration::from_millis(400);
const REFRESH_EVENTS: [&str; 4] = [
    "command.started",
    "command.finished",
    "pane.created",
    "pane.closed",
];
const PORTS_SOURCE: &str = "ports";
const NEUTRAL: &str = "neutral";

pub const PORTS_ITEMS_CHANNEL: &str = "ports:items";

type Groups = Vec<(String, WorkspaceProcesses)>;
type PaneList = Pin<Box<dyn Future<Output = Vec<PaneRef>> + Send>>;
type TreeMap = Pin<Box<dyn Future<Output = HashMap<i32, TreeInfo>> + Send>>;

pub struct PortsServiceDeps {
    pub settings: Box<dyn Fn() -> PortsSettings + Send + Sync>,
    pub list_panes: Box<dyn Fn() -> PaneList + Send + Sync>,
    pub renderer_pane_id: Box<dyn Fn(&str) -> Option<String> + Send + Sync>,
    pub send: Box<dyn Fn(&str, &str, Value) + Send + Sync>,
    pub scan: Option<Box<dyn Fn(Vec<i32>, i32) -> TreeMap + Send + Sync>>,
    pub host_pid: Option<i32>,
    pub log: Option<Box<dyn Fn(&str) + Send + Sync>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkspacePorts {
    pub workspace_id: String,
    pub ports: Vec<ListeningPort>,
    pub ssh: Vec<String>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortsItems {
    sidebar: Vec<Value>,
    pane_chips: Vec<Value>,
    workspace_chips: Vec<Value>,
}

pub struct PortsData {
    sidebar: Vec<(String, Value)>,
    pane_chips: Vec<(String, Value)>,
    workspace_chips: Vec<(String, Value)>,
}

struct Shared {
    deps: PortsServiceDeps,
    settings: Mutex<PortsSettings>,
}

struct Scanned {
    trees: HashMap<i32, TreeInfo>,
    groups: Groups,
}

impl Shared {
    fn scanned(self: &Arc<Self>, panes: Vec<PaneRef>) -> impl Future<Output = Scanned> + use<> {
        let roots = terminal_pids(&panes);
        let host_pid = self
            .deps
            .host_pid
            .unwrap_or_else(|| i32::try_from(std::process::id()).unwrap_or(0));
        let trees: TreeMap = match &self.deps.scan {
            Some(scan) => scan(roots, host_pid),
            None => Box::pin(async move { scan_trees(&roots, host_pid).await }),
        };
        async move {
            let trees = trees.await;
            let groups = group_by_workspace(&panes, &trees);
            Scanned { trees, groups }
        }
    }

    fn items(&self, panes: &[PaneRef], scanned: &Scanned) -> PortsData {
        let settings = self.settings.lock().clone();
        let workspace_of: HashMap<&str, &str> = panes
            .iter()
            .map(|pane| (pane.pane_id.as_str(), pane.workspace_id.as_str()))
            .collect();
        let sidebar = sidebar_entries(&scanned.groups)
            .into_iter()
            .map(|entry| {
                let mut item = extension_item();
                item.insert("workspaceId".to_owned(), json!(entry.workspace_id));
                item.insert("key".to_owned(), json!(entry.key));
                item.insert("text".to_owned(), json!(entry.text));
                if let Some(icon) = entry.icon {
                    item.insert("icon".to_owned(), json!(icon));
                }
                if let Some(badge) = entry.badge {
                    item.insert("badge".to_owned(), json!(badge));
                }
                item.insert("kind".to_owned(), json!(entry.kind));
                (entry.workspace_id, Value::Object(item))
            })
            .collect();
        let mut pane_chips = Vec::new();
        for chip in pane_chip_values(panes, &scanned.trees) {
            let Some(pane_id) = (self.deps.renderer_pane_id)(&chip.pane_id) else {
                continue;
            };
            let Some(workspace_id) = workspace_of.get(chip.pane_id.as_str()) else {
                continue;
            };
            let mut item = extension_item();
            merge(&mut item, &chip);
            item.insert("paneId".to_owned(), json!(pane_id));
            pane_chips.push(((*workspace_id).to_owned(), Value::Object(item)));
        }
        let workspace_chips = workspace_chip_values(&scanned.groups, settings.port_host)
            .into_iter()
            .map(|chip| {
                let mut item = extension_item();
                merge(&mut item, &chip);
                (chip.workspace_id, Value::Object(item))
            })
            .collect();
        PortsData {
            sidebar,
            pane_chips,
            workspace_chips,
        }
    }
}

fn extension_item() -> Map<String, Value> {
    let mut item = Map::new();
    item.insert("extId".to_owned(), json!(PORTS_SOURCE));
    item.insert("tone".to_owned(), json!(NEUTRAL));
    item
}

fn merge(item: &mut Map<String, Value>, value: &impl Serialize) {
    if let Ok(Value::Object(fields)) = serde_json::to_value(value) {
        item.extend(fields);
    }
}

fn pick(entries: &[(String, Value)], ids: &BTreeSet<String>) -> Vec<Value> {
    entries
        .iter()
        .filter(|(workspace_id, _)| ids.contains(workspace_id))
        .map(|(_, value)| value.clone())
        .collect()
}

struct PortsSource {
    shared: Arc<Shared>,
}

impl RefreshSource for PortsSource {
    type Data = PortsData;
    type Items = PortsItems;

    fn enabled(&self) -> bool {
        self.shared.settings.lock().enabled
    }

    fn poll_ms(&self) -> u64 {
        u64::from(self.shared.settings.lock().interval_seconds) * 1000
    }

    fn read(&self, watched: &BTreeSet<String>) -> ReadFuture<PortsData> {
        let watched = watched.clone();
        let shared = Arc::clone(&self.shared);
        let listing = (shared.deps.list_panes)();
        Box::pin(async move {
            let panes: Vec<PaneRef> = listing
                .await
                .into_iter()
                .filter(|pane| watched.contains(&pane.workspace_id))
                .collect();
            let scanned = shared.scanned(panes.clone()).await;
            Ok(shared.items(&panes, &scanned))
        })
    }

    fn items_for(&self, ids: &BTreeSet<String>, data: &PortsData) -> PortsItems {
        PortsItems {
            sidebar: pick(&data.sidebar, ids),
            pane_chips: pick(&data.pane_chips, ids),
            workspace_chips: pick(&data.workspace_chips, ids),
        }
    }
}

pub struct PortsService {
    shared: Arc<Shared>,
    refresher: WatchedRefresher<PortsSource>,
}

impl PortsService {
    pub fn new(deps: PortsServiceDeps) -> Self {
        let settings = (deps.settings)();
        let shared = Arc::new(Shared {
            deps,
            settings: Mutex::new(settings),
        });
        let send_shared = Arc::clone(&shared);
        let log_shared = Arc::clone(&shared);
        let options = WatchedRefresherOptions {
            channel: PORTS_ITEMS_CHANNEL.to_owned(),
            debounce: REFRESH_DEBOUNCE,
            events: REFRESH_EVENTS
                .iter()
                .map(|e| (*e).to_owned())
                .collect::<HashSet<_>>(),
            send: Arc::new(move |window_id: &str, channel: &str, items: &PortsItems| {
                if let Ok(payload) = serde_json::to_value(items) {
                    (send_shared.deps.send)(window_id, channel, payload);
                }
            }),
            log: Some(Arc::new(move |line: &str| {
                if let Some(log) = &log_shared.deps.log {
                    log(line);
                }
            })),
        };
        let refresher = WatchedRefresher::new(
            PortsSource {
                shared: Arc::clone(&shared),
            },
            options,
        );
        Self { shared, refresher }
    }

    pub fn active(&self) -> bool {
        self.refresher.active()
    }

    pub fn polling(&self) -> bool {
        self.refresher.polling()
    }

    pub fn pending(&self) -> bool {
        self.refresher.pending()
    }

    pub fn watch(&self, window_id: &str, workspace_ids: &[&str]) {
        self.refresher.watch(window_id, &json!(workspace_ids));
    }

    pub fn window_gone(&self, window_id: &str) {
        self.refresher.window_gone(window_id);
    }

    pub fn set_focused(&self, focused: bool) {
        self.refresher.set_focused(focused);
    }

    pub fn activity(&self, event_type: &str) {
        self.refresher.activity(event_type);
    }

    pub fn stop(&self) {
        self.refresher.stop();
    }

    pub fn refresh(&self) -> impl Future<Output = ()> + Send + use<> {
        self.refresher.refresh()
    }

    pub fn settings_changed(&self) {
        *self.shared.settings.lock() = (self.shared.deps.settings)();
        self.refresher.apply();
    }

    pub fn list(&self) -> impl Future<Output = Vec<WorkspacePorts>> + Send + use<> {
        let shared = Arc::clone(&self.shared);
        let listing = (shared.deps.list_panes)();
        async move {
            let scanned = shared.scanned(listing.await).await;
            scanned
                .groups
                .into_iter()
                .map(|(workspace_id, group)| WorkspacePorts {
                    workspace_id,
                    ports: group.ports,
                    ssh: group.ssh,
                })
                .collect()
        }
    }
}
