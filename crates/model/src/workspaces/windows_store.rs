use ostia_contract::windows_api::WindowSummary;

#[derive(Clone, Debug, Default)]
pub struct WindowsStore {
    window_id: Option<String>,
    detached: bool,
    list: Vec<WindowSummary>,
}

impl WindowsStore {
    pub fn window_id(&self) -> Option<&str> {
        self.window_id.as_deref()
    }

    pub fn detached(&self) -> bool {
        self.detached
    }

    pub fn list(&self) -> &[WindowSummary] {
        &self.list
    }

    pub fn set_info(&mut self, window_id: &str, detached: bool) -> bool {
        self.window_id = Some(window_id.to_owned());
        self.detached = detached;
        true
    }

    pub fn set_list(&mut self, list: Vec<WindowSummary>) -> bool {
        self.list = list;
        true
    }
}
