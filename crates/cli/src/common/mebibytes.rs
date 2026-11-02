const MEBIBYTE: usize = 1024 * 1024;

pub fn rounded_mebibytes(bytes: usize) -> usize {
    bytes / MEBIBYTE + usize::from(bytes % MEBIBYTE >= MEBIBYTE / 2)
}
