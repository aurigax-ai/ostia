use std::borrow::Cow;

use gpui_kit::{App, AssetSource, Result, SharedString};

use crate::icons::{IconWeight, current_weight, embedded_svg, kit_icon_target};

pub struct AppAssets;

fn phosphor_for(path: &str) -> Option<&'static [u8]> {
    let name = path.strip_prefix("icons/")?.strip_suffix(".svg")?;
    if let Some((folder, file)) = name.split_once('/') {
        return embedded_svg(IconWeight::from_folder(folder)?, file);
    }
    embedded_svg(current_weight(), kit_icon_target(name)?)
}

impl AssetSource for AppAssets {
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        Ok(phosphor_for(path).map(Cow::Borrowed))
    }

    fn list(&self, _path: &str) -> Result<Vec<SharedString>> {
        Ok(Vec::new())
    }
}

const FONTS: &[&[u8]] = &[
    include_bytes!("../assets/fonts/Inter-Regular.ttf"),
    include_bytes!("../assets/fonts/Inter-Medium.ttf"),
    include_bytes!("../assets/fonts/Inter-SemiBold.ttf"),
    include_bytes!("../assets/fonts/GeistMono-Regular.ttf"),
    include_bytes!("../assets/fonts/GeistMono-Medium.ttf"),
    include_bytes!("../assets/fonts/GeistMono-SemiBold.ttf"),
    include_bytes!("../assets/fonts/HackNerdFontMono-Regular.ttf"),
    include_bytes!("../assets/fonts/HackNerdFontMono-Bold.ttf"),
    include_bytes!("../assets/fonts/HackNerdFontMono-Italic.ttf"),
    include_bytes!("../assets/fonts/HackNerdFontMono-BoldItalic.ttf"),
];

pub(crate) fn load_fonts(cx: &mut App) {
    let fonts = FONTS.iter().map(|font| Cow::Borrowed(*font)).collect();
    if let Err(error) = cx.text_system().add_fonts(fonts) {
        tracing::error!(%error, "bundled fonts failed to load");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kit_icon_paths_serve_phosphor_svgs() {
        let bytes = phosphor_for("icons/chevron-down.svg").expect("mapped");
        assert_eq!(
            bytes,
            embedded_svg(current_weight(), "caret-down").expect("embedded")
        );
    }

    #[test]
    fn weighted_paths_serve_that_weight() {
        let bytes = phosphor_for("icons/regular/plus.svg").expect("embedded");
        assert_eq!(
            bytes,
            embedded_svg(IconWeight::Regular, "plus").expect("embedded")
        );
    }

    #[test]
    fn an_unmapped_icon_is_absent_and_never_another_family() {
        assert!(phosphor_for("icons/not-a-kit-icon.svg").is_none());
    }
}
