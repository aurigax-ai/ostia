use std::cell::Cell;
use std::rc::Rc;

use gpui_kit::component::IndexPath;
use gpui_kit::component::command::{Command, CommandGroup, CommandItem, CommandState};
use gpui_kit::prelude::*;
use gpui_kit::{App, Entity, SharedString, WeakEntity, Window, div, px};
use ostia_model::layout::types::Direction;
use ostia_ui::components::{PaletteRow, close_dialog, open_dialog};
use ostia_ui::theme::{UiTheme, set_theme, themes};
use ostia_ui::tokens::{PALETTE_W, RADIUS_LG, TextStep, UiText};

use super::root::{ActiveView, ShellRoot};
use super::window_stores::WindowStores;

const LIST_MAX_H: f32 = 432.;
const TOP_FRACTION: f32 = 0.12;

type Run = Rc<dyn Fn(&mut Window, &mut App)>;
type StoreAction = fn(&WindowStores, &mut App);

const WORKSPACE_COMMANDS: &[(&str, &str, Option<&str>, StoreAction)] = &[
    (
        "New Workspace",
        "workspace.new",
        Some("Ctrl+Shift+N"),
        WindowStores::new_workspace,
    ),
    (
        "Close Workspace",
        "workspace.close",
        None,
        WindowStores::close_active_workspace,
    ),
    (
        "New Terminal",
        "pane.newTerminal",
        Some("Ctrl+Shift+T"),
        WindowStores::new_terminal,
    ),
    (
        "Split Pane Right",
        "pane.splitRight",
        Some("Ctrl+Alt+\\"),
        |stores, cx| stores.split_active(Direction::Horizontal, cx),
    ),
    ("Split Pane Down", "pane.splitDown", None, |stores, cx| {
        stores.split_active(Direction::Vertical, cx)
    }),
    (
        "Close Pane",
        "pane.close",
        None,
        WindowStores::close_active_pane,
    ),
];

fn workspace_group(root: &WeakEntity<ShellRoot>) -> PaletteGroup {
    let commands = WORKSPACE_COMMANDS
        .iter()
        .map(|(title, id, keys, action)| {
            let action = *action;
            let target = root.clone();
            let run: Run = Rc::new(move |_, cx| {
                let _ = target.update(cx, |root, cx| {
                    let stores = root.stores.clone();
                    action(&stores, cx);
                    root.show_workspace(cx);
                });
            });
            PaletteCommand {
                title: (*title).into(),
                id: (*id).into(),
                keys: *keys,
                run,
            }
        })
        .collect();
    PaletteGroup {
        heading: "Workspace",
        commands,
    }
}

struct PaletteCommand {
    title: SharedString,
    id: SharedString,
    keys: Option<&'static str>,
    run: Run,
}

struct PaletteGroup {
    heading: &'static str,
    commands: Vec<PaletteCommand>,
}

fn groups(root: WeakEntity<ShellRoot>) -> Vec<PaletteGroup> {
    let workspace = workspace_group(&root);
    let rail_root = root.clone();
    let settings_root = root;
    let toggle_rail: Run = Rc::new(move |_, cx| {
        let _ = rail_root.update(cx, |root, cx| root.toggle_rail(cx));
    });
    let open_settings: Run = Rc::new(move |_, cx| {
        let _ = settings_root.update(cx, |root, cx| root.select_view(ActiveView::Settings, cx));
    });
    vec![
        workspace,
        PaletteGroup {
            heading: "View",
            commands: vec![
                PaletteCommand {
                    title: "Toggle Sidebar".into(),
                    id: "view.toggleRail".into(),
                    keys: Some("Ctrl+Shift+B"),
                    run: toggle_rail,
                },
                PaletteCommand {
                    title: "Open Settings".into(),
                    id: "app.openSettings".into(),
                    keys: Some("Ctrl+,"),
                    run: open_settings,
                },
            ],
        },
        PaletteGroup {
            heading: "Theme",
            commands: themes()
                .iter()
                .map(|theme| {
                    let id = theme.id;
                    let run: Run = Rc::new(move |_, cx| set_theme(id, cx));
                    PaletteCommand {
                        title: format!("Use {} Theme", theme.name).into(),
                        id: format!("theme.{id}").into(),
                        keys: None,
                        run,
                    }
                })
                .collect(),
        },
    ]
}

fn command_item(command: &PaletteCommand) -> CommandItem {
    let title = command.title.clone();
    let id = command.id.clone();
    let keys = command.keys;
    CommandItem::new()
        .label(command.title.clone())
        .keywords([command.id.clone()])
        .child(move |_, _| {
            let row = PaletteRow::new(title.clone()).meta_code(id.clone());
            match keys {
                Some(keys) => row.keys(keys),
                None => row,
            }
        })
}

fn build_command(state: &Entity<CommandState>, groups: &Rc<Vec<PaletteGroup>>) -> Command {
    let confirm_groups = groups.clone();
    groups
        .iter()
        .fold(Command::new(state), |command, group| {
            command.group(
                CommandGroup::new()
                    .label(group.heading)
                    .items(group.commands.iter().map(command_item)),
            )
        })
        .placeholder("Search or run a command")
        .max_h(px(LIST_MAX_H))
        .on_confirm(move |path: IndexPath, window, cx| {
            let run = confirm_groups
                .get(path.section)
                .and_then(|group| group.commands.get(path.row))
                .map(|command| command.run.clone());
            close_dialog(window, cx);
            if let Some(run) = run {
                run(window, cx);
            }
        })
}

pub(super) fn open(root: WeakEntity<ShellRoot>, window: &mut Window, cx: &mut App) {
    let state = cx.new(|cx| CommandState::new(window, cx));
    let groups = Rc::new(groups(root));
    let focused = Cell::new(false);
    open_dialog(window, cx, move |dialog, window, cx| {
        if !focused.replace(true) {
            state.update(cx, |state, cx| state.focus(window, cx));
        }
        let top = window.viewport_size().height * TOP_FRACTION;
        let state = state.clone();
        let groups = groups.clone();
        dialog
            .w(PALETTE_W)
            .margin_top(top)
            .close_button(false)
            .p_0()
            .content(move |content, _, cx| {
                let t = *cx.tokens();
                content.child(
                    div()
                        .rounded(RADIUS_LG)
                        .bg(t.surface_2)
                        .ui_text(TextStep::Base, cx)
                        .child(build_command(&state, &groups)),
                )
            })
    });
}
