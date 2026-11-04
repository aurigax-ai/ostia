use std::collections::HashSet;

use ostia_contract::chat_tools::{READ_OUTSIDE_GRANT, is_standing_chat_grant};
use ostia_model::assist::chat_tool_permissions::{
    ApprovalAnswer, ApprovalKind, ApprovalScope, CHAT_MODES, ChatMode, CommandChoice,
    DEFAULT_CHAT_MODE, PaneRole, ToolAccess, ToolCheck, ToolDecision, WriteAskReason,
    always_grant_after, decide_tool, grants_after, initial_mode, reads_outside_unasked,
};

fn set(items: &[&str]) -> HashSet<String> {
    items.iter().map(|s| (*s).to_owned()).collect()
}

fn check(name: &str, access: ToolAccess) -> ToolCheck {
    ToolCheck {
        name: name.to_owned(),
        access,
        mode: ChatMode::Ask,
        grants: HashSet::new(),
        standing: HashSet::new(),
        always_ask: HashSet::new(),
        outside: false,
        symlink: false,
        repository: false,
        unsaved: false,
    }
}

fn ask(
    kind: ApprovalKind,
    grant_key: Option<&str>,
    reason: Option<WriteAskReason>,
) -> ToolDecision {
    ToolDecision::Ask {
        kind,
        grant_key: grant_key.map(str::to_owned),
        reason,
    }
}

fn once() -> ApprovalAnswer {
    ApprovalAnswer::Approved {
        scope: ApprovalScope::Once,
        choice: None,
    }
}

fn for_chat() -> ApprovalAnswer {
    ApprovalAnswer::Approved {
        scope: ApprovalScope::Chat,
        choice: None,
    }
}

fn always() -> ApprovalAnswer {
    ApprovalAnswer::Approved {
        scope: ApprovalScope::Always,
        choice: None,
    }
}

fn is_ask(decision: &ToolDecision) -> bool {
    matches!(decision, ToolDecision::Ask { .. })
}

#[test]
fn starts_every_chat_in_ask_mode() {
    assert_eq!(DEFAULT_CHAT_MODE, ChatMode::Ask);
}

#[test]
fn runs_read_only_tools_inside_the_workspace_folder_in_each_mode() {
    for mode in CHAT_MODES {
        let tool = ToolCheck {
            mode,
            ..check("read_file", ToolAccess::Read)
        };
        assert_eq!(decide_tool(&tool), ToolDecision::Run, "{mode:?}");
    }
}

#[test]
fn asks_before_reading_outside_the_folder_in_each_mode() {
    for mode in CHAT_MODES {
        let outside = ToolCheck {
            mode,
            outside: true,
            ..check("read_file", ToolAccess::Read)
        };
        assert_eq!(
            decide_tool(&outside),
            ask(ApprovalKind::ReadOutside, Some(READ_OUTSIDE_GRANT), None),
            "{mode:?}"
        );
        let granted = ToolCheck {
            mode,
            outside: true,
            grants: set(&[READ_OUTSIDE_GRANT]),
            ..check("list_directory", ToolAccess::Read)
        };
        assert_eq!(decide_tool(&granted), ToolDecision::Run, "{mode:?}");
    }
}

#[test]
fn asks_for_acting_tools_and_mcp_tools_until_the_chat_grants_that_tool_in_each_mode() {
    for mode in CHAT_MODES {
        let open_url = ToolCheck {
            mode,
            ..check("open_url", ToolAccess::Act)
        };
        assert_eq!(
            decide_tool(&open_url),
            ask(ApprovalKind::Act, Some("open_url"), None),
            "{mode:?}"
        );
        let granted = ToolCheck {
            grants: set(&["open_url"]),
            ..open_url
        };
        assert_eq!(decide_tool(&granted), ToolDecision::Run, "{mode:?}");
        let other = ToolCheck {
            mode,
            grants: set(&["open_url"]),
            ..check("open_file", ToolAccess::Act)
        };
        assert!(is_ask(&decide_tool(&other)), "{mode:?}");
        let mcp = ToolCheck {
            mode,
            ..check("mcp__fs__read", ToolAccess::Mcp)
        };
        assert_eq!(
            decide_tool(&mcp),
            ask(ApprovalKind::Mcp, Some("mcp__fs__read"), None),
            "{mode:?}"
        );
        let mcp_granted = ToolCheck {
            mode,
            grants: set(&["mcp__fs__write"]),
            ..check("mcp__fs__write", ToolAccess::Mcp)
        };
        assert_eq!(decide_tool(&mcp_granted), ToolDecision::Run, "{mode:?}");
    }
}

#[test]
fn asks_for_every_command_in_each_mode_with_nothing_to_grant() {
    for mode in CHAT_MODES {
        let tool = ToolCheck {
            mode,
            grants: set(&[
                "propose_command",
                "write_file",
                "edit_file",
                READ_OUTSIDE_GRANT,
            ]),
            ..check("propose_command", ToolAccess::Command)
        };
        assert_eq!(
            decide_tool(&tool),
            ask(ApprovalKind::Command, None, None),
            "{mode:?}"
        );
    }
}

#[test]
fn asks_for_every_edit_in_ask_mode_with_nothing_to_grant() {
    for name in ["write_file", "edit_file"] {
        let tool = ToolCheck {
            grants: set(&["write_file", "edit_file"]),
            ..check(name, ToolAccess::Write)
        };
        assert_eq!(
            decide_tool(&tool),
            ask(ApprovalKind::Write, None, Some(WriteAskReason::AskMode)),
            "{name}"
        );
    }
}

#[test]
fn applies_an_edit_inside_the_workspace_folder_without_asking_in_write_mode() {
    for name in ["write_file", "edit_file"] {
        let tool = ToolCheck {
            mode: ChatMode::Write,
            ..check(name, ToolAccess::Write)
        };
        assert_eq!(decide_tool(&tool), ToolDecision::Run, "{name}");
    }
}

#[test]
fn still_asks_in_either_mode_when_the_edit_is_outside_symlinked_in_a_repository_or_unsaved() {
    let cases = [
        (
            WriteAskReason::Outside,
            ToolCheck {
                outside: true,
                ..check("edit_file", ToolAccess::Write)
            },
        ),
        (
            WriteAskReason::Symlink,
            ToolCheck {
                symlink: true,
                ..check("edit_file", ToolAccess::Write)
            },
        ),
        (
            WriteAskReason::Repository,
            ToolCheck {
                repository: true,
                ..check("edit_file", ToolAccess::Write)
            },
        ),
        (
            WriteAskReason::Unsaved,
            ToolCheck {
                unsaved: true,
                ..check("edit_file", ToolAccess::Write)
            },
        ),
    ];
    for (reason, flagged) in cases {
        for mode in CHAT_MODES {
            let tool = ToolCheck {
                mode,
                ..flagged.clone()
            };
            assert_eq!(
                decide_tool(&tool),
                ask(ApprovalKind::Write, None, Some(reason)),
                "{reason:?} {mode:?}"
            );
        }
    }
}

#[test]
fn names_the_outside_folder_first_when_several_reasons_apply() {
    let tool = ToolCheck {
        mode: ChatMode::Write,
        outside: true,
        symlink: true,
        unsaved: true,
        ..check("write_file", ToolAccess::Write)
    };
    assert_eq!(
        decide_tool(&tool),
        ask(ApprovalKind::Write, None, Some(WriteAskReason::Outside))
    );
}

#[test]
fn names_the_symlink_before_the_repository_and_the_repository_before_unsaved() {
    let tool = ToolCheck {
        mode: ChatMode::Write,
        symlink: true,
        repository: true,
        unsaved: true,
        ..check("write_file", ToolAccess::Write)
    };
    assert_eq!(
        decide_tool(&tool),
        ask(ApprovalKind::Write, None, Some(WriteAskReason::Symlink))
    );
    let tool = ToolCheck {
        symlink: false,
        ..tool
    };
    assert_eq!(
        decide_tool(&tool),
        ask(ApprovalKind::Write, None, Some(WriteAskReason::Repository))
    );
}

#[test]
fn adds_a_grant_only_for_allow_for_this_chat_on_a_grantable_decision() {
    let none = HashSet::new();
    let act = decide_tool(&check("open_url", ToolAccess::Act));
    let mut chat: Vec<String> = grants_after(&none, &act, &for_chat()).into_iter().collect();
    chat.sort();
    assert_eq!(chat, vec!["open_url".to_owned()]);
    assert!(grants_after(&none, &act, &once()).is_empty());
    assert!(grants_after(&none, &act, &ApprovalAnswer::Denied).is_empty());
    let write = decide_tool(&check("write_file", ToolAccess::Write));
    assert!(grants_after(&none, &write, &for_chat()).is_empty());
}

#[test]
fn keeps_the_grants_it_already_had_when_it_adds_one() {
    let act = decide_tool(&check("open_url", ToolAccess::Act));
    let next = grants_after(&set(&["open_file"]), &act, &for_chat());
    assert_eq!(next, set(&["open_file", "open_url"]));
    assert_eq!(
        grants_after(&set(&["open_file"]), &ToolDecision::Run, &for_chat()),
        set(&["open_file"])
    );
}

#[test]
fn runs_a_tool_always_allowed_in_an_earlier_chat_without_asking_in_the_same_scope() {
    let standing = set(&["open_url", "mcp__fake__echo", READ_OUTSIDE_GRANT]);
    let act = ToolCheck {
        standing: standing.clone(),
        ..check("open_url", ToolAccess::Act)
    };
    assert_eq!(decide_tool(&act), ToolDecision::Run);
    let mcp = ToolCheck {
        standing: standing.clone(),
        ..check("mcp__fake__echo", ToolAccess::Mcp)
    };
    assert_eq!(decide_tool(&mcp), ToolDecision::Run);
    let read = ToolCheck {
        standing: standing.clone(),
        outside: true,
        ..check("read_file", ToolAccess::Read)
    };
    assert_eq!(decide_tool(&read), ToolDecision::Run);
    assert!(reads_outside_unasked(&HashSet::new(), &standing));
}

#[test]
fn still_asks_outside_the_granted_scope() {
    let standing = set(&["open_url", "mcp__fake__echo"]);
    let act = ToolCheck {
        standing: standing.clone(),
        ..check("open_file", ToolAccess::Act)
    };
    assert_eq!(
        decide_tool(&act),
        ask(ApprovalKind::Act, Some("open_file"), None)
    );
    let mcp = ToolCheck {
        standing: standing.clone(),
        ..check("mcp__other__echo", ToolAccess::Mcp)
    };
    assert_eq!(
        decide_tool(&mcp),
        ask(ApprovalKind::Mcp, Some("mcp__other__echo"), None)
    );
    let read = ToolCheck {
        standing: standing.clone(),
        outside: true,
        ..check("read_file", ToolAccess::Read)
    };
    assert!(matches!(
        decide_tool(&read),
        ToolDecision::Ask {
            kind: ApprovalKind::ReadOutside,
            ..
        }
    ));
    assert!(!reads_outside_unasked(&HashSet::new(), &standing));
}

#[test]
fn reads_outside_unasked_when_the_chat_grants_it() {
    assert!(reads_outside_unasked(
        &set(&[READ_OUTSIDE_GRANT]),
        &HashSet::new()
    ));
    assert!(!reads_outside_unasked(&HashSet::new(), &HashSet::new()));
}

#[test]
fn never_lets_a_standing_grant_run_a_proposed_command_or_skip_the_mode_for_edits() {
    let standing = set(&["propose_command", "edit_file", "write_file"]);
    let command = ToolCheck {
        standing: standing.clone(),
        ..check("propose_command", ToolAccess::Command)
    };
    assert_eq!(
        decide_tool(&command),
        ask(ApprovalKind::Command, None, None)
    );
    for name in ["edit_file", "write_file"] {
        let edit = ToolCheck {
            standing: standing.clone(),
            ..check(name, ToolAccess::Write)
        };
        assert_eq!(
            decide_tool(&edit),
            ask(ApprovalKind::Write, None, Some(WriteAskReason::AskMode)),
            "{name}"
        );
    }
}

#[test]
fn makes_a_standing_grant_only_for_always_allow_on_a_grantable_decision() {
    let none = HashSet::new();
    let act = decide_tool(&check("open_url", ToolAccess::Act));
    assert_eq!(
        always_grant_after(&act, &always()),
        Some("open_url".to_owned())
    );
    assert!(grants_after(&none, &act, &always()).is_empty());
    assert_eq!(always_grant_after(&act, &for_chat()), None);
    assert_eq!(always_grant_after(&act, &once()), None);
    assert_eq!(always_grant_after(&act, &ApprovalAnswer::Denied), None);
    let read = decide_tool(&ToolCheck {
        outside: true,
        ..check("read_file", ToolAccess::Read)
    });
    assert_eq!(
        always_grant_after(&read, &always()),
        Some(READ_OUTSIDE_GRANT.to_owned())
    );
    for decision in [
        decide_tool(&check("propose_command", ToolAccess::Command)),
        decide_tool(&check("edit_file", ToolAccess::Write)),
        decide_tool(&check("write_file", ToolAccess::Write)),
    ] {
        assert_eq!(always_grant_after(&decision, &always()), None);
    }
}

#[test]
fn never_makes_a_standing_grant_when_the_tool_already_runs() {
    assert_eq!(always_grant_after(&ToolDecision::Run, &always()), None);
}

#[test]
fn keeps_the_command_choice_of_an_approval_without_changing_the_grant() {
    let run = ApprovalAnswer::Approved {
        scope: ApprovalScope::Once,
        choice: Some(CommandChoice::Run),
    };
    let command = decide_tool(&check("propose_command", ToolAccess::Command));
    assert!(grants_after(&HashSet::new(), &command, &run).is_empty());
    assert_eq!(always_grant_after(&command, &run), None);
}

fn act_check(patch: impl FnOnce(&mut ToolCheck)) -> ToolCheck {
    let mut tool = check("ostia_agent_run", ToolAccess::Ostia);
    patch(&mut tool);
    tool
}

#[test]
fn asks_on_every_call_of_an_ostia_tool_in_ask_mode_with_no_chat_or_always_grant_to_give() {
    let asks = ask(ApprovalKind::Ostia, None, None);
    assert_eq!(decide_tool(&act_check(|t| t.mode = ChatMode::Ask)), asks);
    let granted = act_check(|t| {
        t.mode = ChatMode::Ask;
        t.grants = set(&["ostia_agent_run"]);
        t.standing = set(&["ostia_agent_run"]);
    });
    assert_eq!(decide_tool(&granted), asks);
}

#[test]
fn runs_an_ostia_tool_in_allow_mode_unless_the_human_listed_the_tool_as_always_ask() {
    let asks = ask(ApprovalKind::Ostia, None, None);
    assert_eq!(
        decide_tool(&act_check(|t| t.mode = ChatMode::Write)),
        ToolDecision::Run
    );
    let listed = act_check(|t| {
        t.mode = ChatMode::Write;
        t.always_ask = set(&["ostia_agent_run"]);
    });
    assert_eq!(decide_tool(&listed), asks);
    let other = act_check(|t| {
        t.name = "ostia_bus_send".to_owned();
        t.mode = ChatMode::Write;
        t.always_ask = set(&["ostia_agent_run"]);
    });
    assert_eq!(decide_tool(&other), ToolDecision::Run);
}

#[test]
fn never_offers_a_standing_grant_for_an_ostia_tool_and_leaves_open_url_and_open_file_as_they_were()
{
    assert!(!is_standing_chat_grant("ostia_agent_run"));
    assert!(!is_standing_chat_grant("ostia_bus_send"));
    let open_url = ToolCheck {
        mode: ChatMode::Write,
        always_ask: set(&["open_url"]),
        ..check("open_url", ToolAccess::Act)
    };
    assert_eq!(
        decide_tool(&open_url),
        ask(ApprovalKind::Act, Some("open_url"), None)
    );
}

#[test]
fn starts_a_normal_agent_pane_in_ask_and_a_manager_pane_in_allow() {
    assert_eq!(initial_mode(PaneRole::Agent), ChatMode::Ask);
    assert_eq!(initial_mode(PaneRole::Manager), ChatMode::Write);
}
