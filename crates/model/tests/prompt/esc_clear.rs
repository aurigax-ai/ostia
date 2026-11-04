use ostia_model::prompt::esc_clear::{ESC_ARM_MS, ESC_CLEARED_MS, EscAction, EscInput, esc_action};

fn base() -> EscInput {
    EscInput {
        vim: false,
        suggestion: false,
        clears: true,
        text: "git status".to_owned(),
        armed: false,
    }
}

#[test]
fn arms_on_the_first_esc_over_a_draft() {
    assert_eq!(esc_action(&base()), EscAction::Arm);
}

#[test]
fn clears_on_the_second_esc_while_armed() {
    let input = EscInput {
        armed: true,
        ..base()
    };
    assert_eq!(esc_action(&input), EscAction::Clear);
}

#[test]
fn does_nothing_on_an_empty_draft() {
    let empty = EscInput {
        text: String::new(),
        ..base()
    };
    assert_eq!(esc_action(&empty), EscAction::None);
    let empty_armed = EscInput {
        armed: true,
        ..empty
    };
    assert_eq!(esc_action(&empty_armed), EscAction::None);
}

#[test]
fn does_nothing_when_the_setting_only_closes_menus() {
    let closes = EscInput {
        clears: false,
        ..base()
    };
    assert_eq!(esc_action(&closes), EscAction::None);
    let closes_armed = EscInput {
        armed: true,
        ..closes
    };
    assert_eq!(esc_action(&closes_armed), EscAction::None);
}

#[test]
fn dismisses_a_suggestion_before_it_arms() {
    let input = EscInput {
        suggestion: true,
        ..base()
    };
    assert_eq!(esc_action(&input), EscAction::Dismiss);
}

#[test]
fn leaves_esc_to_vim_which_never_clears() {
    let armed = EscInput {
        vim: true,
        armed: true,
        ..base()
    };
    assert_eq!(esc_action(&armed), EscAction::Normal);
    let suggesting = EscInput {
        vim: true,
        suggestion: true,
        ..base()
    };
    assert_eq!(esc_action(&suggesting), EscAction::Normal);
}

#[test]
fn keeps_the_arm_and_cleared_windows() {
    assert_eq!(ESC_ARM_MS, 1000);
    assert_eq!(ESC_CLEARED_MS, 3000);
}
