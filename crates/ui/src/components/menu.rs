pub use gpui_kit::component::menu::{
    DropdownMenu as Menu, PopupMenu as MenuContent, PopupMenuItem as MenuItem,
};

use gpui_kit::{App, SharedString, Window};

use crate::icons::IconName;

pub fn menu_item(
    label: impl Into<SharedString>,
    icon: Option<IconName>,
    on_click: impl Fn(&gpui_kit::ClickEvent, &mut Window, &mut App) + 'static,
) -> MenuItem {
    let item = MenuItem::new(label).on_click(on_click);
    match icon {
        Some(name) => item.icon(name),
        None => item,
    }
}
