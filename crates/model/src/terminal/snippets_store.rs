use ostia_contract::snippets::{SnippetEntry, SnippetListing};

#[derive(Clone, Debug, Default)]
pub struct SnippetsStore {
    picker_open: bool,
    listing: SnippetListing,
    target_pane_id: Option<String>,
    chosen: Option<SnippetEntry>,
    save_command: Option<String>,
}

impl SnippetsStore {
    pub fn picker_open(&self) -> bool {
        self.picker_open
    }

    pub fn listing(&self) -> &SnippetListing {
        &self.listing
    }

    pub fn target_pane_id(&self) -> Option<&str> {
        self.target_pane_id.as_deref()
    }

    pub fn chosen(&self) -> Option<&SnippetEntry> {
        self.chosen.as_ref()
    }

    pub fn save_command(&self) -> Option<&str> {
        self.save_command.as_deref()
    }

    pub fn show_picker(&mut self, listing: SnippetListing, target_pane_id: Option<&str>) {
        self.picker_open = true;
        self.listing = listing;
        self.target_pane_id = target_pane_id.map(str::to_owned);
        self.chosen = None;
    }

    pub fn close_picker(&mut self) {
        self.picker_open = false;
        self.chosen = None;
    }

    pub fn choose(&mut self, snippet: Option<SnippetEntry>) {
        self.chosen = snippet;
    }

    pub fn start_save(&mut self, command: Option<&str>) {
        self.save_command = command.map(str::to_owned);
    }
}
