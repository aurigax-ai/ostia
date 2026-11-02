use subtle::ConstantTimeEq;

pub fn same_bytes(left: &[u8], right: &[u8]) -> bool {
    left.ct_eq(right).into()
}
