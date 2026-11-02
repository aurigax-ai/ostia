use std::collections::HashMap;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LiveSelectionSource {
    Editor {
        file: String,
        start_line: u32,
        end_line: u32,
    },
    Terminal,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LiveSelection {
    pub pane_id: String,
    pub source: LiveSelectionSource,
    pub text: String,
}

#[derive(Clone, Debug, Default)]
pub struct LiveSelectionStore {
    by_workspace: HashMap<String, LiveSelection>,
}

impl LiveSelectionStore {
    pub fn of_workspace(&self, workspace_id: &str) -> Option<&LiveSelection> {
        self.by_workspace.get(workspace_id)
    }

    pub fn is_empty(&self) -> bool {
        self.by_workspace.is_empty()
    }

    pub fn report(
        &mut self,
        workspace_id: &str,
        pane_id: &str,
        source: LiveSelectionSource,
        text: &str,
    ) -> bool {
        if text.trim().is_empty() {
            return self.clear(pane_id);
        }
        self.by_workspace.insert(
            workspace_id.to_owned(),
            LiveSelection {
                pane_id: pane_id.to_owned(),
                source,
                text: text.to_owned(),
            },
        );
        true
    }

    pub fn clear(&mut self, pane_id: &str) -> bool {
        let owner = self
            .by_workspace
            .iter()
            .find(|(_, selection)| selection.pane_id == pane_id)
            .map(|(workspace_id, _)| workspace_id.clone());
        match owner {
            Some(owner) => self.by_workspace.remove(&owner).is_some(),
            None => false,
        }
    }
}
