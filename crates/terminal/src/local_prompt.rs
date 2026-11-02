#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PromptOwner {
    pub foreground: String,
    pub shell: String,
    pub sandboxed: bool,
}

fn program_name(value: &str) -> &str {
    let base = value
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or_default();
    base.strip_prefix('-').unwrap_or(base)
}

pub fn at_local_prompt(owner: &PromptOwner) -> bool {
    if owner.sandboxed || owner.shell.is_empty() || owner.foreground.is_empty() {
        return true;
    }
    program_name(&owner.foreground) == program_name(&owner.shell)
}

pub fn busy_program(owner: &PromptOwner) -> Option<String> {
    if at_local_prompt(owner) {
        None
    } else {
        Some(program_name(&owner.foreground).to_owned())
    }
}

pub fn shell_idle(owner: &PromptOwner) -> bool {
    !owner.sandboxed && !owner.foreground.is_empty() && busy_program(owner).is_none()
}
