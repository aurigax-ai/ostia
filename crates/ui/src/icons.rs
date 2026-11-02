use std::sync::atomic::{AtomicBool, Ordering};

use gpui_kit::component::IconNamed;
use gpui_kit::{Hsla, SharedString, Styled, Svg, px, svg};

macro_rules! icon_table {
    ($($variant:ident => $file:literal,)*) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
        pub enum IconName {
            $($variant,)*
        }

        impl IconName {
            pub const ALL: &'static [IconName] = &[$(IconName::$variant,)*];

            pub const fn file_name(self) -> &'static str {
                match self {
                    $(Self::$variant => $file,)*
                }
            }
        }

        pub(crate) fn embedded_svg(weight: IconWeight, file: &str) -> Option<&'static [u8]> {
            match (weight, file) {
                $(
                    (IconWeight::Regular, $file) => Some(include_bytes!(concat!("../assets/icons/regular/", $file, ".svg"))),
                    (IconWeight::Bold, $file) => Some(include_bytes!(concat!("../assets/icons/bold/", $file, ".svg"))),
                )*
                _ => None,
            }
        }
    };
}

include!("icon_table.rs");

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IconWeight {
    Regular,
    Bold,
}

impl IconWeight {
    pub const fn folder(self) -> &'static str {
        match self {
            Self::Regular => "regular",
            Self::Bold => "bold",
        }
    }

    pub fn from_folder(folder: &str) -> Option<Self> {
        match folder {
            "regular" => Some(Self::Regular),
            "bold" => Some(Self::Bold),
            _ => None,
        }
    }

    pub fn for_scale(scale_factor: f32) -> Self {
        let whole = scale_factor.round();
        let on_grid = (scale_factor - whole).abs() < 0.01 && whole >= 2. && whole % 2. == 0.;
        if on_grid { Self::Regular } else { Self::Bold }
    }
}

static USE_REGULAR_WEIGHT: AtomicBool = AtomicBool::new(false);

pub fn current_weight() -> IconWeight {
    if USE_REGULAR_WEIGHT.load(Ordering::Relaxed) {
        IconWeight::Regular
    } else {
        IconWeight::Bold
    }
}

pub fn sync_icon_weight(scale_factor: f32) {
    let regular = IconWeight::for_scale(scale_factor) == IconWeight::Regular;
    USE_REGULAR_WEIGHT.store(regular, Ordering::Relaxed);
}

impl IconNamed for IconName {
    fn path(self) -> SharedString {
        format!(
            "icons/{}/{}.svg",
            current_weight().folder(),
            self.file_name()
        )
        .into()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IconSize {
    Standard,
    Badge,
}

impl IconSize {
    pub const fn pixels(self) -> f32 {
        match self {
            Self::Standard => 16.,
            Self::Badge => 12.,
        }
    }
}

pub fn icon(name: IconName, size: IconSize, color: Hsla) -> Svg {
    svg()
        .path(name.path())
        .flex_none()
        .size(px(size.pixels()))
        .text_color(color)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn weight_matches_the_electron_rule() {
        assert_eq!(IconWeight::for_scale(1.), IconWeight::Bold);
        assert_eq!(IconWeight::for_scale(1.5), IconWeight::Bold);
        assert_eq!(IconWeight::for_scale(2.), IconWeight::Regular);
        assert_eq!(IconWeight::for_scale(3.), IconWeight::Bold);
        assert_eq!(IconWeight::for_scale(4.), IconWeight::Regular);
    }

    #[test]
    fn every_icon_has_both_weights() {
        for name in IconName::ALL {
            assert!(embedded_svg(IconWeight::Regular, name.file_name()).is_some());
            assert!(embedded_svg(IconWeight::Bold, name.file_name()).is_some());
        }
    }
}
