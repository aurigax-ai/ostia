#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TabMoveRefusal {
    Same,
    Unknown,
    Manager,
    Scratch,
    Sandbox,
}
