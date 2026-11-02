use gpui_kit::{Hsla, Rgba};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rgba8 {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub a: f32,
}

impl Rgba8 {
    pub const fn rgb(packed: u32) -> Self {
        Self::rgba(packed, 1.0)
    }

    pub const fn rgba(packed: u32, a: f32) -> Self {
        Self {
            r: ((packed >> 16) & 0xff) as u8,
            g: ((packed >> 8) & 0xff) as u8,
            b: (packed & 0xff) as u8,
            a,
        }
    }

    pub fn hsla(self) -> Hsla {
        Rgba {
            r: f32::from(self.r) / 255.0,
            g: f32::from(self.g) / 255.0,
            b: f32::from(self.b) / 255.0,
            a: self.a,
        }
        .into()
    }

    fn luminance(self) -> f32 {
        fn channel(value: u8) -> f32 {
            let unit = f32::from(value) / 255.0;
            if unit <= 0.04045 {
                unit / 12.92
            } else {
                ((unit + 0.055) / 1.055).powf(2.4)
            }
        }
        0.2126 * channel(self.r) + 0.7152 * channel(self.g) + 0.0722 * channel(self.b)
    }

    pub fn contrast(self, other: Self) -> f32 {
        let (a, b) = (self.luminance(), other.luminance());
        (a.max(b) + 0.05) / (a.min(b) + 0.05)
    }
}

const INK_DARK: Rgba8 = Rgba8::rgb(0x0b0d10);
const INK_LIGHT: Rgba8 = Rgba8::rgb(0xffffff);
const READABLE_CONTRAST: f32 = 4.5;

pub fn readable_on(fill: Rgba8, preferred: &[Rgba8]) -> Rgba8 {
    if let Some(found) = preferred
        .iter()
        .find(|candidate| candidate.contrast(fill) >= READABLE_CONTRAST)
    {
        return *found;
    }
    if fill.contrast(INK_DARK) >= fill.contrast(INK_LIGHT) {
        INK_DARK
    } else {
        INK_LIGHT
    }
}

pub fn mix_over(foreground: Hsla, amount: f32) -> Hsla {
    foreground.opacity(amount)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_unpacks_to_channels() {
        let color = Rgba8::rgb(0x1d2022);
        assert_eq!((color.r, color.g, color.b), (0x1d, 0x20, 0x22));
    }

    #[test]
    fn readable_on_prefers_the_first_candidate_that_reads() {
        let brand = Rgba8::rgb(0x00d8ff);
        let bg = Rgba8::rgb(0x1d2022);
        let fg = Rgba8::rgb(0xe3edf5);
        assert_eq!(readable_on(brand, &[bg, fg]), bg);
    }

    #[test]
    fn readable_on_falls_back_to_the_stronger_ink() {
        let mid = Rgba8::rgb(0x808080);
        let result = readable_on(mid, &[mid]);
        assert!(result == INK_DARK || result == INK_LIGHT);
    }
}
