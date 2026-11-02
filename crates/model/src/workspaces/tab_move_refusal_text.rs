use super::tab_workspace_move::TabMoveRefusal;

pub struct TabMoveStrings {
    pub same: String,
    pub unknown: String,
    pub manager: String,
    pub scratch: String,
    pub sandbox: String,
}

pub fn tab_move_refusal_text(
    strings: &TabMoveStrings,
    refusal: Option<TabMoveRefusal>,
) -> Option<&str> {
    refusal.map(|refusal| match refusal {
        TabMoveRefusal::Same => strings.same.as_str(),
        TabMoveRefusal::Unknown => strings.unknown.as_str(),
        TabMoveRefusal::Manager => strings.manager.as_str(),
        TabMoveRefusal::Scratch => strings.scratch.as_str(),
        TabMoveRefusal::Sandbox => strings.sandbox.as_str(),
    })
}
