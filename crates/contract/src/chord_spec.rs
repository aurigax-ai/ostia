#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChordSpec {
    pub ctrl: bool,
    pub shift: bool,
    pub alt: bool,
    pub meta: bool,
    pub key: String,
}
