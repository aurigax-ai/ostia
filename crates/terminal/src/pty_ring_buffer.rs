const COMMAND_START_MARK: &str = "\x1b]133;C";
const ESC: u16 = 0x1b;
const NEWLINE: u16 = 0x0a;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RingSlice {
    pub data: String,
    pub cursor: usize,
    pub dropped: bool,
    pub starts_before: usize,
}

pub fn tail_cut(data: &str, keep: usize) -> usize {
    let units: Vec<u16> = data.encode_utf16().collect();
    tail_cut_units(&units, keep)
}

fn tail_cut_units(units: &[u16], keep: usize) -> usize {
    let Some(cut) = units.len().checked_sub(keep).filter(|cut| *cut > 0) else {
        return 0;
    };
    let newline = find_unit(units, cut, NEWLINE);
    let esc = find_unit(units, cut, ESC);
    match (newline, esc) {
        (Some(nl), e) if e.is_none_or(|e| nl <= e) => nl + 1,
        (_, Some(e)) => e,
        _ => cut,
    }
}

fn find_unit(units: &[u16], from: usize, unit: u16) -> Option<usize> {
    units[from..]
        .iter()
        .position(|candidate| *candidate == unit)
        .map(|offset| offset + from)
}

pub fn count_command_starts(data: &str, end: Option<usize>) -> usize {
    let units: Vec<u16> = data.encode_utf16().collect();
    count_units(&units, end)
}

fn count_units(units: &[u16], end: Option<usize>) -> usize {
    let end = end.unwrap_or(units.len()).min(units.len());
    units[..end]
        .windows(COMMAND_START_MARK.len())
        .filter(|window| window.iter().copied().eq(COMMAND_START_MARK.encode_utf16()))
        .count()
}

pub struct PtyRingBuffer {
    units: Vec<u16>,
    start: usize,
    dropped_starts: usize,
    cap: usize,
    keep: usize,
    base: usize,
}

impl PtyRingBuffer {
    pub fn new(cap: usize) -> Self {
        Self::with_base(cap, 0)
    }

    pub fn with_base(cap: usize, base: usize) -> Self {
        Self {
            units: Vec::new(),
            start: base,
            dropped_starts: 0,
            cap,
            keep: cap - (cap >> 2),
            base,
        }
    }

    pub fn end(&self) -> usize {
        self.start + self.units.len()
    }

    pub fn push(&mut self, data: &str) {
        self.units.extend(data.encode_utf16());
        if self.units.len() <= self.cap {
            return;
        }
        let cut = tail_cut_units(&self.units, self.keep);
        self.dropped_starts += count_units(&self.units, Some(cut));
        self.start += cut;
        self.units.drain(..cut);
    }

    pub fn since(&self, cursor: usize) -> RingSlice {
        let at = if cursor == 0 { self.base } else { cursor };
        let end = self.end();
        let dropped = at < self.start || at > end;
        let from = if dropped { 0 } else { at - self.start };
        RingSlice {
            data: String::from_utf16_lossy(&self.units[from..]),
            cursor: end,
            dropped,
            starts_before: self.dropped_starts + count_units(&self.units, Some(from)),
        }
    }
}
