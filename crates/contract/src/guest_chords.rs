use crate::chord_spec::KeyLike;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GuestChordFire {
    pub guest_id: u32,
    pub key: KeyLike,
}
