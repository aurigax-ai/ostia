#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_model::settings::terminal_pane_settings::LinkClick;
use ostia_model::terminal::ostia_terminal::{TerminalPosition, TerminalRange};
use ostia_model::terminal_links::link_modifier::{
    LinkSpan, PathLinkClick, PathLinkContext, PathLinkTarget, TerminalLinkTarget, WebLinkClick,
    WebLinkClickContext, WebLinkTarget, link_claims_press, link_modifier_held, link_span,
    path_link_target, terminal_link_target, web_link_target,
};

#[test]
fn marks_the_host_while_ctrl_is_held_and_clears_it_on_release() {
    assert!(link_modifier_held(true, false, false));
    assert!(!link_modifier_held(false, false, false));
}

#[test]
fn uses_cmd_instead_of_ctrl_on_macos() {
    assert!(!link_modifier_held(true, false, true));
    assert!(link_modifier_held(false, true, true));
}

#[test]
fn follows_the_modifier_state_of_mouse_moves_and_clears_on_window_blur() {
    assert!(link_modifier_held(true, false, false));
    assert!(!link_modifier_held(false, false, false));
}

mod path_link {
    use super::*;

    const LINUX: PathLinkContext = PathLinkContext {
        mac: false,
        link_click: LinkClick::App,
    };

    fn none() -> PathLinkClick {
        PathLinkClick::default()
    }

    #[test]
    fn opens_in_ostia_on_ctrl_click_with_the_default_app_on_ctrl_shift_click_and_shows_the_folder_with_alt()
     {
        assert_eq!(
            path_link_target(
                PathLinkClick {
                    ctrl: true,
                    ..none()
                },
                LINUX
            ),
            Some(PathLinkTarget::Open)
        );
        assert_eq!(
            path_link_target(
                PathLinkClick {
                    ctrl: true,
                    shift: true,
                    ..none()
                },
                LINUX
            ),
            Some(PathLinkTarget::OpenSystem)
        );
        assert_eq!(
            path_link_target(
                PathLinkClick {
                    ctrl: true,
                    alt: true,
                    ..none()
                },
                LINUX
            ),
            Some(PathLinkTarget::Show)
        );
        assert_eq!(
            path_link_target(
                PathLinkClick {
                    ctrl: true,
                    alt: true,
                    shift: true,
                    ..none()
                },
                LINUX
            ),
            Some(PathLinkTarget::ShowSystem)
        );
    }

    #[test]
    fn does_nothing_without_the_link_modifier_alt_and_shift_included() {
        assert_eq!(path_link_target(none(), LINUX), None);
        assert_eq!(
            path_link_target(
                PathLinkClick {
                    alt: true,
                    ..none()
                },
                LINUX
            ),
            None
        );
        assert_eq!(
            path_link_target(
                PathLinkClick {
                    shift: true,
                    alt: true,
                    ..none()
                },
                LINUX
            ),
            None
        );
    }

    #[test]
    fn uses_cmd_instead_of_ctrl_on_macos() {
        let mac = PathLinkContext { mac: true, ..LINUX };
        assert_eq!(
            path_link_target(
                PathLinkClick {
                    meta: true,
                    ..none()
                },
                mac
            ),
            Some(PathLinkTarget::Open)
        );
        assert_eq!(
            path_link_target(
                PathLinkClick {
                    meta: true,
                    shift: true,
                    ..none()
                },
                mac
            ),
            Some(PathLinkTarget::OpenSystem)
        );
        assert_eq!(
            path_link_target(
                PathLinkClick {
                    meta: true,
                    alt: true,
                    ..none()
                },
                mac
            ),
            Some(PathLinkTarget::Show)
        );
        assert_eq!(
            path_link_target(
                PathLinkClick {
                    ctrl: true,
                    ..none()
                },
                mac
            ),
            None
        );
    }

    #[test]
    fn swaps_ostia_and_the_system_on_both_pairs_when_terminal_link_click_is_system() {
        let swapped = PathLinkContext {
            link_click: LinkClick::System,
            ..LINUX
        };
        assert_eq!(
            path_link_target(
                PathLinkClick {
                    ctrl: true,
                    ..none()
                },
                swapped
            ),
            Some(PathLinkTarget::OpenSystem)
        );
        assert_eq!(
            path_link_target(
                PathLinkClick {
                    ctrl: true,
                    shift: true,
                    ..none()
                },
                swapped
            ),
            Some(PathLinkTarget::Open)
        );
        assert_eq!(
            path_link_target(
                PathLinkClick {
                    ctrl: true,
                    alt: true,
                    ..none()
                },
                swapped
            ),
            Some(PathLinkTarget::ShowSystem)
        );
        assert_eq!(
            path_link_target(
                PathLinkClick {
                    ctrl: true,
                    alt: true,
                    shift: true,
                    ..none()
                },
                swapped
            ),
            Some(PathLinkTarget::Show)
        );
    }
}

mod web_link {
    use super::*;

    const PLAIN: WebLinkClick = WebLinkClick {
        ctrl: false,
        meta: false,
        shift: false,
        detail: 1,
    };
    const IDLE: WebLinkClickContext = WebLinkClickContext {
        mac: false,
        has_selection: false,
        mouse_reporting: false,
        link_click: LinkClick::App,
    };

    fn same_tab() -> Option<WebLinkTarget> {
        Some(WebLinkTarget::SameTab)
    }

    #[test]
    fn opens_a_plain_click_in_the_same_browser_tab() {
        assert_eq!(web_link_target(PLAIN, IDLE), same_tab());
    }

    #[test]
    fn opens_a_ctrl_click_in_a_new_browser_tab_and_ctrl_shift_click_in_the_system_browser() {
        assert_eq!(
            web_link_target(
                WebLinkClick {
                    ctrl: true,
                    ..PLAIN
                },
                IDLE
            ),
            Some(WebLinkTarget::NewTab)
        );
        assert_eq!(
            web_link_target(
                WebLinkClick {
                    ctrl: true,
                    shift: true,
                    ..PLAIN
                },
                IDLE
            ),
            Some(WebLinkTarget::System)
        );
    }

    #[test]
    fn uses_cmd_instead_of_ctrl_on_macos() {
        let mac = WebLinkClickContext { mac: true, ..IDLE };
        assert_eq!(
            web_link_target(
                WebLinkClick {
                    meta: true,
                    ..PLAIN
                },
                mac
            ),
            Some(WebLinkTarget::NewTab)
        );
        assert_eq!(
            web_link_target(
                WebLinkClick {
                    meta: true,
                    shift: true,
                    ..PLAIN
                },
                mac
            ),
            Some(WebLinkTarget::System)
        );
        assert_eq!(
            web_link_target(
                WebLinkClick {
                    ctrl: true,
                    ..PLAIN
                },
                mac
            ),
            None
        );
        assert_eq!(
            web_link_target(
                WebLinkClick {
                    ctrl: true,
                    ..PLAIN
                },
                IDLE
            ),
            Some(WebLinkTarget::NewTab)
        );
        assert_eq!(
            web_link_target(
                WebLinkClick {
                    meta: true,
                    ..PLAIN
                },
                IDLE
            ),
            None
        );
    }

    #[test]
    fn swaps_the_new_tab_and_the_system_browser_when_the_setting_asks_on_linux_and_macos() {
        let linux = WebLinkClickContext {
            link_click: LinkClick::System,
            ..IDLE
        };
        assert_eq!(
            web_link_target(
                WebLinkClick {
                    ctrl: true,
                    ..PLAIN
                },
                linux
            ),
            Some(WebLinkTarget::System)
        );
        assert_eq!(
            web_link_target(
                WebLinkClick {
                    ctrl: true,
                    shift: true,
                    ..PLAIN
                },
                linux
            ),
            Some(WebLinkTarget::NewTab)
        );
        assert_eq!(web_link_target(PLAIN, linux), same_tab());
        let mac = WebLinkClickContext { mac: true, ..linux };
        assert_eq!(
            web_link_target(
                WebLinkClick {
                    meta: true,
                    ..PLAIN
                },
                mac
            ),
            Some(WebLinkTarget::System)
        );
        assert_eq!(
            web_link_target(
                WebLinkClick {
                    meta: true,
                    shift: true,
                    ..PLAIN
                },
                mac
            ),
            Some(WebLinkTarget::NewTab)
        );
        assert_eq!(
            web_link_target(
                WebLinkClick {
                    ctrl: true,
                    ..PLAIN
                },
                mac
            ),
            None
        );
    }

    #[test]
    fn ignores_a_plain_click_that_ends_a_selection_or_drag_or_is_a_double_click() {
        assert_eq!(
            web_link_target(
                PLAIN,
                WebLinkClickContext {
                    has_selection: true,
                    ..IDLE
                }
            ),
            None
        );
        assert_eq!(
            web_link_target(WebLinkClick { detail: 2, ..PLAIN }, IDLE),
            None
        );
        assert_eq!(
            web_link_target(
                WebLinkClick {
                    shift: true,
                    ..PLAIN
                },
                IDLE
            ),
            None
        );
    }

    #[test]
    fn leaves_a_plain_click_to_a_program_that_reports_the_mouse_but_keeps_modifier_clicks() {
        let tui = WebLinkClickContext {
            mouse_reporting: true,
            ..IDLE
        };
        assert_eq!(web_link_target(PLAIN, tui), None);
        assert_eq!(
            web_link_target(
                WebLinkClick {
                    ctrl: true,
                    ..PLAIN
                },
                tui
            ),
            Some(WebLinkTarget::NewTab)
        );
        assert_eq!(
            web_link_target(
                WebLinkClick {
                    ctrl: true,
                    shift: true,
                    ..PLAIN
                },
                tui
            ),
            Some(WebLinkTarget::System)
        );
    }

    #[test]
    fn keeps_modifier_clicks_working_over_a_selection() {
        let selected = WebLinkClickContext {
            has_selection: true,
            ..IDLE
        };
        assert_eq!(
            web_link_target(
                WebLinkClick {
                    ctrl: true,
                    ..PLAIN
                },
                selected
            ),
            Some(WebLinkTarget::NewTab)
        );
    }
}

#[test]
fn maps_a_one_row_link_to_zero_based_viewport_cells_end_exclusive() {
    let range = TerminalRange {
        start: TerminalPosition { x: 5, y: 12 },
        end: TerminalPosition { x: 14, y: 12 },
    };
    assert_eq!(
        link_span(range, 10, 80),
        LinkSpan {
            row: 1,
            start: 4,
            end: 14
        }
    );
}

#[test]
fn runs_a_wrapped_link_to_the_end_of_its_first_row() {
    let range = TerminalRange {
        start: TerminalPosition { x: 70, y: 3 },
        end: TerminalPosition { x: 9, y: 4 },
    };
    assert_eq!(
        link_span(range, 0, 80),
        LinkSpan {
            row: 2,
            start: 69,
            end: 80
        }
    );
}

#[test]
fn keeps_a_claimed_press_from_reaching_the_terminal_behind_the_link_layer() {
    assert!(link_claims_press(0, || true));
}

#[test]
fn lets_unclaimed_presses_and_other_buttons_through() {
    assert!(!link_claims_press(0, || false));
    assert!(!link_claims_press(2, || true));
}

mod terminal_link {
    use super::*;

    const CTX: WebLinkClickContext = WebLinkClickContext {
        mac: true,
        has_selection: false,
        mouse_reporting: false,
        link_click: LinkClick::App,
    };
    const CLICK: WebLinkClick = WebLinkClick {
        ctrl: false,
        meta: false,
        shift: false,
        detail: 1,
    };
    const VAULT: &str = "obsidian://advanced-uri?vault=Interdisciplinary Nexus&filepath=中文.md";

    #[test]
    fn opens_obsidian_vscode_and_mail_links_in_their_app_on_a_click_with_or_without_the_modifier() {
        for uri in [
            VAULT,
            "vscode://file/a.ts",
            "vscode-insiders://file/a",
            "mailto:a@b.c",
        ] {
            assert_eq!(
                terminal_link_target(uri, CLICK, CTX),
                Some(TerminalLinkTarget::App),
                "{uri}"
            );
            assert_eq!(
                terminal_link_target(
                    uri,
                    WebLinkClick {
                        meta: true,
                        ..CLICK
                    },
                    CTX
                ),
                Some(TerminalLinkTarget::App),
                "{uri} with the modifier"
            );
        }
    }

    #[test]
    fn opens_any_other_scheme_with_a_double_slash_in_its_app() {
        for uri in ["slack://channel?id=1", "zed://file/tmp/a", "x-app://do"] {
            assert_eq!(
                terminal_link_target(uri, CLICK, CTX),
                Some(TerminalLinkTarget::App),
                "{uri}"
            );
        }
    }

    #[test]
    fn keeps_web_links_in_the_browser_targets() {
        assert_eq!(
            terminal_link_target("https://a.b", CLICK, CTX),
            Some(TerminalLinkTarget::Web(WebLinkTarget::SameTab))
        );
        assert_eq!(
            terminal_link_target(
                "https://a.b",
                WebLinkClick {
                    meta: true,
                    ..CLICK
                },
                CTX
            ),
            Some(TerminalLinkTarget::Web(WebLinkTarget::NewTab))
        );
        assert_eq!(
            terminal_link_target(
                "https://a.b",
                WebLinkClick {
                    meta: true,
                    shift: true,
                    ..CLICK
                },
                CTX
            ),
            Some(TerminalLinkTarget::Web(WebLinkTarget::System))
        );
    }

    #[test]
    fn ignores_scripts_files_data_and_unknown_schemes() {
        for uri in [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "data:text/html,x",
            "x-app:do",
            "ostia-preview://s/index.html",
            "devtools://devtools/a",
        ] {
            assert_eq!(terminal_link_target(uri, CLICK, CTX), None, "{uri}");
            assert_eq!(
                terminal_link_target(
                    uri,
                    WebLinkClick {
                        meta: true,
                        shift: true,
                        ..CLICK
                    },
                    CTX
                ),
                None,
                "{uri} with the modifier"
            );
        }
    }

    #[test]
    fn leaves_app_links_alone_while_selecting_or_when_the_program_reads_the_mouse() {
        assert_eq!(
            terminal_link_target(
                VAULT,
                CLICK,
                WebLinkClickContext {
                    has_selection: true,
                    ..CTX
                }
            ),
            None
        );
        assert_eq!(
            terminal_link_target(
                VAULT,
                CLICK,
                WebLinkClickContext {
                    mouse_reporting: true,
                    ..CTX
                }
            ),
            None
        );
    }
}
