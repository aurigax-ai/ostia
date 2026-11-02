pub use ostia_contract::attention::AttentionState;

#[derive(Clone, Debug, PartialEq)]
pub struct PaneAttention {
    pub state: AttentionState,
    pub unread: bool,
    pub message: Option<String>,
    pub at: f64,
}
