#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AssistPoint {
    Input,
    Command,
    Completion,
    Terminal,
    Chat,
}
