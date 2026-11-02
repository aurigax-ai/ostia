use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::Value;

use crate::playbooks::{
    PlaybookExtraFile, active_playbooks, collapse_spaces, parse_playbooks, skill_text,
};
use crate::skill_directive::skill_directive;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlaybookFile {
    pub id: String,
    pub description: String,
    pub skill: String,
    pub files: Vec<PlaybookExtraFile>,
}

pub fn playbook_files(raw: &Value, taken: &[&str]) -> Vec<PlaybookFile> {
    active_playbooks(&parse_playbooks(raw))
        .into_iter()
        .filter(|playbook| !taken.contains(&playbook.id.as_str()))
        .filter_map(|playbook| {
            let skill = skill_text(&playbook);
            if skill_directive(&skill).is_some()
                || playbook
                    .files
                    .iter()
                    .any(|file| skill_directive(&file.text).is_some())
            {
                return None;
            }
            Some(PlaybookFile {
                description: collapse_spaces(&playbook.description),
                id: playbook.id,
                skill,
                files: playbook.files,
            })
        })
        .collect()
}

#[derive(Clone, Debug, Default)]
pub struct CurrentPlaybooks {
    settings: Arc<Mutex<Value>>,
}

impl CurrentPlaybooks {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set(&self, raw: Value) {
        *self.settings.lock() = raw;
    }

    pub fn current(&self) -> Value {
        self.settings.lock().clone()
    }

    pub fn files(&self, taken: &[&str]) -> Vec<PlaybookFile> {
        playbook_files(&self.current(), taken)
    }
}
