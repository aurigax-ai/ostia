use gpui_kit::Context;
use ostia_base::WorkspaceId;
use ostia_park::{ParkedRecord, ParkedStore};

#[derive(Clone)]
pub struct ParkBridge {
    store: ParkedStore,
}

impl ParkBridge {
    pub fn new(store: ParkedStore) -> Self {
        Self { store }
    }

    pub fn list(&self, workspace_id: &str) -> Vec<ParkedRecord> {
        self.store.list(&WorkspaceId::new(workspace_id))
    }

    pub fn notify_on_change<V: 'static>(&self, cx: &mut Context<V>) {
        let mut changes = self.store.subscribe();
        cx.spawn(async move |view, cx| {
            while changes.recv().await.is_some() {
                let alive = view.update(cx, |_: &mut V, cx| cx.notify());
                if alive.is_err() {
                    break;
                }
            }
        })
        .detach();
    }
}
