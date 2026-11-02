use std::collections::HashMap;
use std::sync::Arc;

#[derive(Clone)]
pub struct PhoneSized {
    cols: u16,
    use_desktop: Arc<dyn Fn() + Send + Sync>,
}

impl PhoneSized {
    pub fn new(cols: u16, use_desktop: impl Fn() + Send + Sync + 'static) -> Self {
        Self {
            cols,
            use_desktop: Arc::new(use_desktop),
        }
    }

    pub fn cols(&self) -> u16 {
        self.cols
    }

    pub fn use_desktop(&self) {
        (self.use_desktop)();
    }
}

#[derive(Clone, Default)]
pub struct PhoneSizeStore {
    by_pane: HashMap<String, PhoneSized>,
}

impl PhoneSizeStore {
    pub fn of_pane(&self, pane_id: &str) -> Option<&PhoneSized> {
        self.by_pane.get(pane_id)
    }

    pub fn hold(&mut self, pane_id: &str, sized: PhoneSized) -> bool {
        self.by_pane.insert(pane_id.to_owned(), sized);
        true
    }

    pub fn release(&mut self, pane_id: &str) -> bool {
        self.by_pane.remove(pane_id).is_some()
    }
}
