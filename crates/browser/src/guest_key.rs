use crate::chord_spec::KeyLike;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GuestKeyInput {
    pub kind: String,
    pub key: String,
    pub code: String,
    pub control: bool,
    pub shift: bool,
    pub alt: bool,
    pub meta: bool,
}

impl GuestKeyInput {
    pub fn key_like(&self) -> KeyLike {
        KeyLike {
            key: self.key.clone(),
            code: self.code.clone(),
            ctrl: self.control,
            meta: self.meta,
            shift: self.shift,
            alt: self.alt,
        }
    }
}
