use std::mem;

#[derive(Default)]
pub struct Utf8Decoder {
    pending: Vec<u8>,
    started: bool,
}

fn complete_prefix_len(bytes: &[u8]) -> usize {
    let mut base = 0;
    loop {
        let Err(error) = std::str::from_utf8(&bytes[base..]) else {
            return bytes.len();
        };
        match error.error_len() {
            None => return base + error.valid_up_to(),
            Some(invalid) => base += error.valid_up_to() + invalid,
        }
    }
}

impl Utf8Decoder {
    pub fn decode(&mut self, bytes: &[u8], last: bool) -> String {
        self.pending.extend_from_slice(bytes);
        let mut all = mem::take(&mut self.pending);
        if !last {
            let complete = complete_prefix_len(&all);
            self.pending = all.split_off(complete);
        }
        let mut text = String::from_utf8_lossy(&all).into_owned();
        if !self.started && !text.is_empty() {
            self.started = true;
            if text.starts_with('\u{feff}') {
                text.remove(0);
            }
        }
        text
    }
}
