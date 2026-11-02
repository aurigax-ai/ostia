#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum NewWorkspacePlacement {
    #[default]
    End,
    Top,
    AfterCurrent,
}
