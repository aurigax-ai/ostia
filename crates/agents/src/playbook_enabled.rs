use serde_json::Value;

use crate::playbooks::{active_playbooks, parse_playbooks};

pub fn playbook_enabled(raw: &Value, id: &str) -> bool {
    active_playbooks(&parse_playbooks(raw))
        .iter()
        .any(|playbook| playbook.builtin && playbook.id == id)
}
