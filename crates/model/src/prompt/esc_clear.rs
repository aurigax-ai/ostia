pub const ESC_ARM_MS: u64 = 1000;
pub const ESC_CLEARED_MS: u64 = 3000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EscAction {
    Normal,
    Dismiss,
    Arm,
    Clear,
    None,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EscInput {
    pub vim: bool,
    pub suggestion: bool,
    pub clears: bool,
    pub text: String,
    pub armed: bool,
}

pub fn esc_action(input: &EscInput) -> EscAction {
    if input.vim {
        return EscAction::Normal;
    }
    if input.suggestion {
        return EscAction::Dismiss;
    }
    if !input.clears || input.text.is_empty() {
        return EscAction::None;
    }
    if input.armed {
        EscAction::Clear
    } else {
        EscAction::Arm
    }
}
