pub fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

pub fn from_units(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}

pub fn slice(units: &[u16], from: usize, to: usize) -> &[u16] {
    let end = to.min(units.len());
    let start = from.min(end);
    &units[start..end]
}

pub fn splice(units: &[u16], from: usize, to: usize, insert: &[u16]) -> Vec<u16> {
    let mut next = slice(units, 0, from).to_vec();
    next.extend_from_slice(insert);
    next.extend_from_slice(slice(units, to, units.len()));
    next
}

pub fn unit_char(unit: u16) -> Option<char> {
    char::from_u32(u32::from(unit))
}

const NEWLINE: u16 = b'\n' as u16;

pub fn last_newline_before(units: &[u16], from: i64) -> Option<usize> {
    let last = units.len().checked_sub(1)?;
    let start = usize::try_from(from.max(0)).map_or(last, |from| from.min(last));
    units[..=start].iter().rposition(|unit| *unit == NEWLINE)
}

pub fn line_start(units: &[u16], caret: usize) -> usize {
    let from = i64::try_from(caret).unwrap_or(i64::MAX) - 1;
    last_newline_before(units, from).map_or(0, |at| at + 1)
}

pub fn line_end(units: &[u16], caret: usize) -> usize {
    units
        .iter()
        .enumerate()
        .skip(caret)
        .find(|(_, unit)| **unit == NEWLINE)
        .map_or(units.len(), |(at, _)| at)
}
