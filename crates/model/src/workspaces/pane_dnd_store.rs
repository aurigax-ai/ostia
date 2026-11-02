use crate::layout::types::DropZone;
use crate::panes::drop_zone::TabDrop;

#[derive(Clone, Debug, Default)]
pub struct PaneDndStore {
    dragging: bool,
    source_id: Option<String>,
    over_id: Option<String>,
    zone: Option<DropZone>,
    tab: Option<TabDrop>,
    dropped_here: bool,
}

impl PaneDndStore {
    pub fn over_id(&self) -> Option<&str> {
        self.over_id.as_deref()
    }

    pub fn source_id(&self) -> Option<&str> {
        self.source_id.as_deref()
    }

    pub fn zone(&self) -> Option<DropZone> {
        self.zone
    }

    pub fn tab(&self) -> Option<&TabDrop> {
        self.tab.as_ref()
    }

    pub fn dragging(&self) -> bool {
        self.dragging
    }

    pub fn dropped_here(&self) -> bool {
        self.dropped_here
    }

    pub fn body_zone(&self, pane_id: &str) -> Option<DropZone> {
        if self.over_id.as_deref() == Some(pane_id) && self.tab.is_none() {
            self.zone
        } else {
            None
        }
    }

    pub fn start(&mut self, source_id: Option<&str>) -> bool {
        *self = Self {
            dragging: true,
            source_id: source_id.map(str::to_owned),
            ..Self::default()
        };
        true
    }

    pub fn set_over(&mut self, over_id: &str, zone: DropZone, tab: Option<TabDrop>) -> bool {
        if self.over_id.as_deref() == Some(over_id) && self.zone == Some(zone) && self.tab == tab {
            return false;
        }
        self.over_id = Some(over_id.to_owned());
        self.zone = Some(zone);
        self.tab = tab;
        true
    }

    pub fn leave(&mut self, over_id: &str) -> bool {
        if self.over_id.as_deref() != Some(over_id) {
            return false;
        }
        self.clear_hover();
        true
    }

    pub fn dropped(&mut self) -> bool {
        self.clear_hover();
        self.dropped_here = true;
        true
    }

    pub fn release(&mut self) -> bool {
        if !self.dragging {
            return false;
        }
        self.dragging = false;
        self.clear_hover();
        true
    }

    pub fn reset(&mut self) -> bool {
        *self = Self::default();
        true
    }

    fn clear_hover(&mut self) {
        self.over_id = None;
        self.zone = None;
        self.tab = None;
    }
}
