use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::Mutex;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EditorPosition {
    pub file: String,
    pub line: u32,
    pub column: u32,
}

type PositionSource = dyn Fn() -> Option<EditorPosition> + Send + Sync;
type Sources = Arc<Mutex<HashMap<String, Arc<PositionSource>>>>;

#[derive(Clone, Default)]
pub struct EditorPositions {
    sources: Sources,
}

pub struct EditorPositionRegistration {
    sources: Sources,
    pane_id: String,
    source: Arc<PositionSource>,
}

impl EditorPositions {
    pub fn register(
        &self,
        pane_id: &str,
        source: impl Fn() -> Option<EditorPosition> + Send + Sync + 'static,
    ) -> EditorPositionRegistration {
        let source: Arc<PositionSource> = Arc::new(source);
        self.sources
            .lock()
            .insert(pane_id.to_owned(), Arc::clone(&source));
        EditorPositionRegistration {
            sources: Arc::clone(&self.sources),
            pane_id: pane_id.to_owned(),
            source,
        }
    }

    pub fn position_of(&self, pane_id: &str) -> Option<EditorPosition> {
        let source = self.sources.lock().get(pane_id).cloned()?;
        source()
    }
}

impl EditorPositionRegistration {
    pub fn release(self) {
        let mut sources = self.sources.lock();
        if sources
            .get(&self.pane_id)
            .is_some_and(|current| Arc::ptr_eq(current, &self.source))
        {
            sources.remove(&self.pane_id);
        }
    }
}
