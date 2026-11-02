use std::sync::Arc;

use ostia_panes::pane_names::PaneNames;
use ostia_terminal::local_prompt::{PromptOwner, shell_idle};

pub type Again = Box<dyn FnOnce() + Send>;
pub type PaneCheck = Box<dyn Fn(&str) -> bool + Send + Sync>;
pub type OwnerLookup = Box<dyn Fn(&str) -> Option<PromptOwner> + Send + Sync>;
pub type Recheck = Box<dyn Fn(&str, Again) + Send + Sync>;

pub struct AgentLeftDeps {
    pub names: PaneNames,
    pub running: PaneCheck,
    pub waking: PaneCheck,
    pub owner: OwnerLookup,
    pub recheck: Recheck,
}

pub fn agent_left(deps: &Arc<AgentLeftDeps>, pane_id: &str) {
    left(deps, pane_id, false);
}

fn left(deps: &Arc<AgentLeftDeps>, pane_id: &str, rechecked: bool) {
    if (deps.running)(pane_id) || (deps.waking)(pane_id) {
        return;
    }
    let Some(owner) = (deps.owner)(pane_id) else {
        return;
    };
    if shell_idle(&owner) {
        deps.names.drop_name(pane_id);
    } else if !rechecked {
        let again_deps = Arc::clone(deps);
        let again_pane = pane_id.to_owned();
        (deps.recheck)(
            pane_id,
            Box::new(move || left(&again_deps, &again_pane, true)),
        );
    }
}
