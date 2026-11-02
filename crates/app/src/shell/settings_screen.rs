use gpui_kit::component::input::{InputEvent, InputState};
use gpui_kit::prelude::*;
use gpui_kit::{
    AnyElement, App, Context, ElementId, Entity, Render, SharedString, Window, div, px,
};
use ostia_ui::components::{
    Badge, BadgeVariant, Button, ButtonSize, ButtonVariant, ControlRow, EmptyBlock, EmptyState,
    IconButton, IconName, Input, ListRow, Notice, NoticeTone, PromptCard, PromptTone, Segmented,
    SegmentedOption, SelectEvent, SelectField, SelectFieldState, SelectOption, SettingsGroup,
    SettingsPage, SplitButton, TextLink, close_dialog, menu_item, open_dialog, select_state,
    toggle_row,
};
use ostia_ui::icons::{IconSize, icon};
use ostia_ui::theme::{UiTheme, set_theme, themes};
use ostia_ui::tokens::{
    SETTINGS_CONTENT_MAX_W, SETTINGS_NAV_W, SPACE_1, SPACE_2, SPACE_5, SPACE_8, TextStep, UiText,
};

const NAV_ROW_H: f32 = 32.;
const NAV_GROUP_GAP: f32 = 12.;
const WIDE_INPUT: f32 = 224.;
const NUMBER_INPUT: f32 = 96.;
const DIALOG_W: f32 = 384.;
const SEARCH_LABEL: &str = "Search settings";

struct NavSection {
    id: &'static str,
    label: &'static str,
    icon: IconName,
}

struct NavGroup {
    label: &'static str,
    sections: &'static [NavSection],
}

const NAV: &[NavGroup] = &[
    NavGroup {
        label: "General",
        sections: &[
            NavSection {
                id: "appearance",
                label: "Appearance",
                icon: IconName::Palette,
            },
            NavSection {
                id: "notifications",
                label: "Notifications",
                icon: IconName::Bell,
            },
            NavSection {
                id: "sync",
                label: "Sync",
                icon: IconName::ArrowsClockwise,
            },
            NavSection {
                id: "shares",
                label: "Shared artifacts",
                icon: IconName::ShareNetwork,
            },
        ],
    },
    NavGroup {
        label: "Terminal",
        sections: &[
            NavSection {
                id: "terminal",
                label: "Terminal",
                icon: IconName::TerminalWindow,
            },
            NavSection {
                id: "prompt",
                label: "Prompt",
                icon: IconName::Terminal,
            },
            NavSection {
                id: "keyboard",
                label: "Keyboard",
                icon: IconName::Keyboard,
            },
            NavSection {
                id: "panes",
                label: "Panes",
                icon: IconName::SquareSplitHorizontal,
            },
        ],
    },
    NavGroup {
        label: "Workspace",
        sections: &[
            NavSection {
                id: "workspaces",
                label: "Workspaces",
                icon: IconName::SquaresFour,
            },
            NavSection {
                id: "sidebar",
                label: "Sidebar",
                icon: IconName::SidebarSimple,
            },
            NavSection {
                id: "files",
                label: "Files",
                icon: IconName::TreeStructure,
            },
            NavSection {
                id: "git",
                label: "Git",
                icon: IconName::GitBranch,
            },
            NavSection {
                id: "ports",
                label: "Ports",
                icon: IconName::Plugs,
            },
            NavSection {
                id: "views",
                label: "Views",
                icon: IconName::Layout,
            },
        ],
    },
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FixtureMode {
    System,
    Reduced,
    Full,
}

pub struct SettingsScreen {
    section: &'static str,
    search: Entity<InputState>,
    theme: Entity<SelectFieldState>,
    fixture_switch: bool,
    fixture_mode: FixtureMode,
    fixture_select: Entity<SelectFieldState>,
    fixture_text: Entity<InputState>,
    fixture_number: Entity<InputState>,
    fixture_runs: usize,
    fixture_card: bool,
}

impl SettingsScreen {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let search = cx.new(|cx| InputState::new(window, cx).placeholder(SEARCH_LABEL));
        cx.subscribe(&search, |_, _, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                cx.notify();
            }
        })
        .detach();
        let current = cx.ui_theme().source.id;
        let options = themes()
            .iter()
            .map(|theme| SelectOption::new(theme.id, theme.name))
            .collect();
        let theme = select_state(options, current, window, cx);
        cx.subscribe(
            &theme,
            |_, _, event: &SelectEvent<Vec<SelectOption>>, cx| {
                if let SelectEvent::Confirm(Some(id)) = event {
                    set_theme(id, cx);
                }
            },
        )
        .detach();
        let fixture_select = select_state(
            vec![
                SelectOption::new("first", "First option"),
                SelectOption::new("second", "Second option"),
            ],
            "first",
            window,
            cx,
        );
        let fixture_text = cx.new(|cx| InputState::new(window, cx).placeholder("Fixture text"));
        let fixture_number = cx.new(|cx| InputState::new(window, cx).default_value("13"));
        Self {
            section: "appearance",
            search,
            theme,
            fixture_switch: true,
            fixture_mode: FixtureMode::System,
            fixture_select,
            fixture_text,
            fixture_number,
            fixture_runs: 0,
            fixture_card: false,
        }
    }

    fn sync_theme_select(&self, window: &mut Window, cx: &mut Context<Self>) {
        let current: SharedString = cx.ui_theme().source.id.into();
        let stale = self.theme.read(cx).selected_value() != Some(&current);
        if stale {
            self.theme.update(cx, |state, cx| {
                state.set_selected_value(&current, window, cx)
            });
        }
    }

    fn render_nav(&self, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let t = *cx.tokens();
        let query = self.search.read(cx).value().to_lowercase();
        let section = self.section;
        let groups: Vec<AnyElement> = NAV
            .iter()
            .filter_map(|group| {
                let rows: Vec<AnyElement> = group
                    .sections
                    .iter()
                    .filter(|item| item.label.to_lowercase().contains(&query))
                    .map(|item| self.render_nav_row(item, section == item.id, cx))
                    .collect();
                if rows.is_empty() {
                    return None;
                }
                Some(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(2.))
                        .child(
                            div()
                                .px(SPACE_2)
                                .pb(SPACE_1)
                                .text_color(t.fg_muted)
                                .ui_text(TextStep::Xs, cx)
                                .ui_weight_medium(cx)
                                .child(group.label),
                        )
                        .children(rows)
                        .into_any_element(),
                )
            })
            .collect();
        div()
            .flex()
            .flex_col()
            .flex_none()
            .h_full()
            .min_h_0()
            .w(SETTINGS_NAV_W)
            .bg(t.surface_1)
            .border_r_1()
            .border_color(t.line)
            .child(
                div()
                    .m(SPACE_2)
                    .child(Input::new(&self.search, SEARCH_LABEL)),
            )
            .child(
                div()
                    .id("settings-nav-scroll")
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .gap(px(NAV_GROUP_GAP))
                    .px(SPACE_2)
                    .pb(SPACE_2)
                    .children(groups),
            )
    }

    fn render_nav_row(
        &self,
        item: &'static NavSection,
        active: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let t = *cx.tokens();
        let id = item.id;
        let select = cx.listener(move |screen, _, _, cx| {
            screen.section = id;
            cx.notify();
        });
        ostia_ui::components::RowButton::new(ElementId::Name(item.id.into()), item.label)
            .active(active)
            .on_click(select)
            .child(
                div()
                    .flex()
                    .flex_1()
                    .h(px(NAV_ROW_H))
                    .items_center()
                    .gap(SPACE_2)
                    .px(SPACE_2)
                    .ui_text(TextStep::Base, cx)
                    .child(icon(
                        item.icon,
                        IconSize::Standard,
                        if active { t.fg } else { t.fg_muted },
                    ))
                    .child(item.label),
            )
            .into_any_element()
    }

    fn render_theme_group(&self) -> impl IntoElement + use<> {
        SettingsGroup::new("Theme").first().child(
            ControlRow::new("Theme")
                .desc("Sets the theme and the terminal colors of this window.")
                .control(SelectField::new(&self.theme, "Theme")),
        )
    }

    fn render_fixture_group(&self, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let toggle = cx.listener(|screen, checked: &bool, _, cx| {
            screen.fixture_switch = *checked;
            cx.notify();
        });
        let entity = cx.entity().downgrade();
        let mode = Segmented::new(
            "fixture-mode",
            self.fixture_mode,
            vec![
                SegmentedOption::new(FixtureMode::System, "System"),
                SegmentedOption::new(FixtureMode::Reduced, "Reduced"),
                SegmentedOption::new(FixtureMode::Full, "Full"),
            ],
            move |value, _, cx| {
                let value = *value;
                let _ = entity.update(cx, |screen, cx| {
                    screen.fixture_mode = value;
                    cx.notify();
                });
            },
        );
        let run = cx.listener(|screen, _, _, cx| {
            screen.fixture_runs += 1;
            cx.notify();
        });
        let run_again = cx.listener(|screen, _, _, cx| {
            screen.fixture_runs += 1;
            cx.notify();
        });
        let reset_counter = cx.entity().downgrade();
        let reset = cx.listener(|screen, _, _, cx| {
            screen.fixture_runs = 0;
            cx.notify();
        });
        let show_card = cx.listener(|screen, _, _, cx| {
            screen.fixture_card = true;
            cx.notify();
        });
        SettingsGroup::new("Fixture controls")
            .desc("One row of each control kind. The values stay in memory. The settings store is not ported.")
            .child(toggle_row(
                "fixture-switch",
                "Switch",
                "A fixture toggle.",
                self.fixture_switch,
                toggle,
            ))
            .child(ControlRow::new("Select").control(SelectField::new(&self.fixture_select, "Select")))
            .child(ControlRow::new("Segmented").control(mode))
            .child(
                ControlRow::new("Text input")
                    .control(Input::new(&self.fixture_text, "Text input").width(WIDE_INPUT)),
            )
            .child(
                ControlRow::new("Number input")
                    .control(Input::new(&self.fixture_number, "Number input").width(NUMBER_INPUT).code()),
            )
            .child(
                ControlRow::new("Buttons")
                    .desc(SharedString::from(format!(
                        "The main action ran {} times.",
                        self.fixture_runs
                    )))
                    .control(TextLink::new("fixture-reset", "Reset").on_click(reset))
                    .control(
                        Button::new("fixture-outline")
                            .label("Show prompt card")
                            .variant(ButtonVariant::Outline)
                            .size(ButtonSize::Sm)
                            .on_click(show_card),
                    )
                    .control(
                        SplitButton::new(
                            "fixture-split",
                            "Run",
                            "More actions",
                            run,
                            move |menu, _, _| {
                                let counter = reset_counter.clone();
                                menu.item(menu_item("Reset counter", Some(IconName::ArrowCounterClockwise), move |_, _, cx| {
                                    let _ = counter.update(cx, |screen, cx| {
                                        screen.fixture_runs = 0;
                                        cx.notify();
                                    });
                                }))
                            },
                        ),
                    )
                    .control(
                        Button::new("fixture-primary")
                            .label("Run once")
                            .size(ButtonSize::Sm)
                            .on_click(run_again),
                    ),
            )
            .child(
                ControlRow::new("Dialog").control(
                    Button::new("fixture-dialog")
                        .label("Open dialog")
                        .variant(ButtonVariant::Outline)
                        .size(ButtonSize::Sm)
                        .on_click(|_, window, cx| open_fixture_dialog(window, cx)),
                ),
            )
            .child(
                ControlRow::new("Badge")
                    .label_hint(Badge::new("Experimental").variant(BadgeVariant::Outline))
                    .control(IconButton::new("fixture-icon", IconName::Info, "A tooltip on an icon button")),
            )
            .child(Notice::new(NoticeTone::Warn, "A fixture warning notice."))
            .child(
                ListRow::new("List row")
                    .lead(icon(IconName::File, IconSize::Standard, cx.tokens().fg_muted))
                    .meta("fixture")
                    .detail("A row with an expandable region.")
                    .expanded("fixture-row", "Show details", false, EmptyBlock::new("Nothing to show")),
            )
    }
}

fn open_fixture_dialog(window: &mut Window, cx: &mut App) {
    open_dialog(window, cx, |dialog, _, cx| {
        let t = *cx.tokens();
        dialog
            .w(px(DIALOG_W))
            .title(
                div()
                    .text_color(t.fg)
                    .ui_text(TextStep::Lg, cx)
                    .ui_weight_medium(cx)
                    .child("Fixture dialog"),
            )
            .footer(
                Button::new("fixture-dialog-close")
                    .label("Close")
                    .size(ButtonSize::Sm)
                    .on_click(|_, window, cx| close_dialog(window, cx)),
            )
    });
}

impl Render for SettingsScreen {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.sync_theme_select(window, cx);
        let t = *cx.tokens();
        let nav = self.render_nav(cx);
        let label = NAV
            .iter()
            .flat_map(|group| group.sections)
            .find(|item| item.id == self.section)
            .map_or("", |item| item.label);
        let page: AnyElement = if self.section == "appearance" {
            let theme_group = self.render_theme_group();
            let fixture_group = self.render_fixture_group(cx);
            SettingsPage::new(label)
                .child(theme_group)
                .child(fixture_group)
                .into_any_element()
        } else {
            EmptyState::surface()
                .title(label)
                .desc("This settings page is not ported.")
                .into_any_element()
        };
        let dismiss = cx.listener(|screen, _, _, cx| {
            screen.fixture_card = false;
            cx.notify();
        });
        div()
            .flex()
            .size_full()
            .min_h_0()
            .bg(t.bg)
            .child(nav)
            .child(
                div()
                    .relative()
                    .flex_1()
                    .min_w_0()
                    .h_full()
                    .child(
                        div()
                            .id("settings-content-scroll")
                            .size_full()
                            .overflow_y_scroll()
                            .flex()
                            .justify_center()
                            .child(
                                div()
                                    .w_full()
                                    .max_w(SETTINGS_CONTENT_MAX_W)
                                    .h_full()
                                    .px(SPACE_8)
                                    .py(SPACE_5)
                                    .child(page),
                            ),
                    )
                    .when(self.fixture_card, |content| {
                        content.child(
                            PromptCard::new(
                                IconName::Warning,
                                "Fixture prompt card",
                                "Dismiss",
                                dismiss,
                            )
                            .tone(PromptTone::Warn)
                            .body("Closing this card never answers a prompt."),
                        )
                    }),
            )
    }
}
