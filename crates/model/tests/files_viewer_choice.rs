#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_model::files::viewer_choice::{
    OWN_VIEW, ViewerChoice, ViewerChoiceInput, ViewerExtension, ViewerKind, ViewerOption,
    ViewerPriority, association_pattern, choose_viewer, viewer_options,
};

fn kind(
    id: &str,
    display_name: &str,
    pattern: &str,
    priority: ViewerPriority,
    approved: bool,
) -> ViewerKind {
    ViewerKind {
        id: id.to_owned(),
        display_name: display_name.to_owned(),
        filename_patterns: vec![pattern.to_owned()],
        view: Some(priority),
        approved,
    }
}

fn ext(id: &str, builtin: bool, kinds: Vec<ViewerKind>, enabled: bool) -> ViewerExtension {
    ViewerExtension {
        id: id.to_owned(),
        builtin,
        enabled,
        file_kinds: kinds,
    }
}

fn sheet() -> ViewerKind {
    kind(
        "office.spreadsheet",
        "Spreadsheet",
        "*.xlsx",
        ViewerPriority::Default,
        true,
    )
}

fn rival() -> ViewerKind {
    kind("acme.grid", "Acme", "*.xlsx", ViewerPriority::Default, true)
}

fn table() -> ViewerKind {
    kind("csv.table", "Table", "*.csv", ViewerPriority::Option, true)
}

fn image() -> ViewerKind {
    kind(
        "images.image",
        "Image",
        "*.png",
        ViewerPriority::Default,
        true,
    )
}

fn extensions() -> Vec<ViewerExtension> {
    vec![
        ext("images", true, vec![image()], true),
        ext("acme", false, vec![rival()], true),
        ext("office", true, vec![sheet()], true),
        ext("csv", true, vec![table()], true),
        ext(
            "off",
            true,
            vec![ViewerKind {
                id: "off.sheet".to_owned(),
                ..sheet()
            }],
            false,
        ),
    ]
}

fn types(options: &[ViewerOption]) -> Vec<&str> {
    options.iter().map(|o| o.view_type.as_str()).collect()
}

fn input(path: &str) -> ViewerChoiceInput {
    ViewerChoiceInput {
        path: path.to_owned(),
        options: viewer_options(Some(path), &extensions()),
        chosen: None,
        associations: Vec::new(),
        in_artifacts: false,
    }
}

fn chosen_type(choice: &ViewerChoice) -> Option<&str> {
    choice.viewer.as_ref().map(|v| v.view_type.as_str())
}

fn own() -> ViewerChoice {
    ViewerChoice {
        viewer: None,
        unavailable: false,
    }
}

fn pair(pattern: &str, view_type: &str) -> (String, String) {
    (pattern.to_owned(), view_type.to_owned())
}

#[test]
fn lists_enabled_matching_viewers_built_ins_first_then_by_extension_id() {
    let options = viewer_options(Some("/w/a.xlsx"), &extensions());
    assert_eq!(types(&options), ["office.spreadsheet", "acme.grid"]);
    assert!(viewer_options(Some("/w/a.txt"), &extensions()).is_empty());
}

#[test]
fn describes_each_viewer_by_its_kind_and_extension() {
    let options = viewer_options(Some("/w/a.xlsx"), &extensions());
    assert_eq!(
        options[0],
        ViewerOption {
            view_type: "office.spreadsheet".to_owned(),
            display_name: "Spreadsheet".to_owned(),
            ext_id: "office".to_owned(),
            builtin: true,
            priority: ViewerPriority::Default,
        }
    );
    assert_eq!(options[1].ext_id, "acme");
    assert!(!options[1].builtin);
    let csv = viewer_options(Some("/w/a.csv"), &extensions());
    assert_eq!(csv[0].priority, ViewerPriority::Option);
}

#[test]
fn leaves_out_a_kind_whose_claim_the_human_has_not_approved() {
    let waiting = ext(
        "wide",
        false,
        vec![ViewerKind {
            id: "wide.grid".to_owned(),
            approved: false,
            ..rival()
        }],
        true,
    );
    let options = viewer_options(Some("/w/a.xlsx"), std::slice::from_ref(&waiting));
    assert!(options.is_empty());
    let choice = choose_viewer(&ViewerChoiceInput {
        path: "/w/a.xlsx".to_owned(),
        options,
        chosen: Some("wide.grid".to_owned()),
        associations: Vec::new(),
        in_artifacts: false,
    });
    assert!(choice.unavailable);
}

#[test]
fn opens_the_first_default_viewer_never_an_option_one_outside_artifacts() {
    assert_eq!(
        chosen_type(&choose_viewer(&input("/w/a.xlsx"))),
        Some("office.spreadsheet")
    );
    assert_eq!(chosen_type(&choose_viewer(&input("/w/a.csv"))), None);
    let in_artifacts = ViewerChoiceInput {
        in_artifacts: true,
        ..input("/w/a.csv")
    };
    assert_eq!(
        chosen_type(&choose_viewer(&in_artifacts)),
        Some("csv.table")
    );
}

#[test]
fn opens_an_image_in_the_images_viewer_and_in_no_viewer_once_that_extension_is_off() {
    assert_eq!(
        chosen_type(&choose_viewer(&input("/w/a.png"))),
        Some("images.image")
    );
    let without: Vec<ViewerExtension> = extensions()
        .into_iter()
        .filter(|extension| extension.id != "images")
        .collect();
    let choice = choose_viewer(&ViewerChoiceInput {
        options: viewer_options(Some("/w/a.png"), &without),
        ..input("/w/a.png")
    });
    assert_eq!(choice, own());
}

#[test]
fn lets_the_pane_choice_and_then_an_association_win_and_keeps_core_views() {
    let chosen = ViewerChoiceInput {
        chosen: Some("acme.grid".to_owned()),
        ..input("/w/a.xlsx")
    };
    assert_eq!(chosen_type(&choose_viewer(&chosen)), Some("acme.grid"));
    let core = ViewerChoiceInput {
        chosen: Some("default".to_owned()),
        ..input("/w/a.xlsx")
    };
    assert_eq!(choose_viewer(&core), own());
    let associated = ViewerChoiceInput {
        associations: vec![pair("*.XLSX", "acme.grid")],
        ..input("/w/a.xlsx")
    };
    assert_eq!(chosen_type(&choose_viewer(&associated)), Some("acme.grid"));
    let own_association = ViewerChoiceInput {
        associations: vec![pair("*.xlsx", "default")],
        ..input("/w/a.xlsx")
    };
    assert_eq!(choose_viewer(&own_association).viewer, None);
}

#[test]
fn falls_back_to_the_own_view_and_says_so_when_the_chosen_viewer_is_gone() {
    let gone = ViewerChoiceInput {
        chosen: Some("off.sheet".to_owned()),
        ..input("/w/a.xlsx")
    };
    assert_eq!(
        choose_viewer(&gone),
        ViewerChoice {
            viewer: None,
            unavailable: true
        }
    );
}

#[test]
fn makes_the_association_pattern_from_the_whole_suffix() {
    assert_eq!(association_pattern("/w/Report.XLSX"), "*.xlsx");
    assert_eq!(association_pattern("/w/src.tar.gz"), "*.tar.gz");
    assert_eq!(association_pattern("/w/Makefile"), "Makefile");
    assert_eq!(association_pattern("/w/.env"), ".env");
}

#[test]
fn the_own_view_is_named_default() {
    assert_eq!(OWN_VIEW, "default");
}

#[test]
fn lists_no_viewer_for_a_missing_or_empty_path() {
    assert!(viewer_options(None, &extensions()).is_empty());
    assert!(viewer_options(Some(""), &extensions()).is_empty());
}

#[test]
fn orders_non_built_in_extensions_by_locale_compare_of_their_id() {
    let list = vec![
        ext(
            "Zeta",
            false,
            vec![kind("z.grid", "Z", "*.xlsx", ViewerPriority::Option, true)],
            true,
        ),
        ext(
            "alpha",
            false,
            vec![kind("a.grid", "A", "*.xlsx", ViewerPriority::Option, true)],
            true,
        ),
        ext(
            "zz",
            true,
            vec![kind("b.grid", "B", "*.xlsx", ViewerPriority::Option, true)],
            true,
        ),
    ];
    let options = viewer_options(Some("/w/a.xlsx"), &list);
    assert_eq!(types(&options), ["b.grid", "a.grid", "z.grid"]);
}

#[test]
fn keeps_the_order_of_kinds_inside_one_extension() {
    let list = vec![ext(
        "multi",
        false,
        vec![
            kind("m.second", "S", "*.xlsx", ViewerPriority::Option, true),
            kind("m.first", "F", "*.xlsx", ViewerPriority::Option, true),
        ],
        true,
    )];
    let options = viewer_options(Some("/w/a.xlsx"), &list);
    assert_eq!(types(&options), ["m.second", "m.first"]);
}

#[test]
fn leaves_out_a_kind_with_no_view() {
    let list = vec![ext(
        "browse",
        true,
        vec![ViewerKind {
            view: None,
            ..sheet()
        }],
        true,
    )];
    assert!(viewer_options(Some("/w/a.xlsx"), &list).is_empty());
}

#[test]
fn matches_filename_patterns_by_base_name_ignoring_case() {
    let list = vec![ext(
        "build",
        true,
        vec![
            kind(
                "build.make",
                "Make",
                "Makefile",
                ViewerPriority::Default,
                true,
            ),
            kind(
                "build.sheet",
                "Sheet",
                "*.xlsx",
                ViewerPriority::Default,
                true,
            ),
        ],
        true,
    )];
    assert_eq!(
        types(&viewer_options(Some("/w/MAKEFILE"), &list)),
        ["build.make"]
    );
    assert!(viewer_options(Some("/w/Makefile.bak"), &list).is_empty());
    assert_eq!(
        types(&viewer_options(Some("C:\\w\\Report.XLSX"), &list)),
        ["build.sheet"]
    );
    assert!(viewer_options(Some("/w/.xlsx"), &list).is_empty());
}

#[test]
fn a_pane_choice_beats_an_association_and_an_empty_choice_is_no_choice() {
    let both = ViewerChoiceInput {
        chosen: Some("office.spreadsheet".to_owned()),
        associations: vec![pair("*.xlsx", "acme.grid")],
        ..input("/w/a.xlsx")
    };
    assert_eq!(
        chosen_type(&choose_viewer(&both)),
        Some("office.spreadsheet")
    );
    let empty = ViewerChoiceInput {
        chosen: Some(String::new()),
        associations: vec![pair("*.xlsx", "acme.grid")],
        ..input("/w/a.xlsx")
    };
    assert_eq!(chosen_type(&choose_viewer(&empty)), Some("acme.grid"));
}

#[test]
fn the_first_matching_association_wins_and_one_to_a_missing_viewer_is_unavailable() {
    let first = ViewerChoiceInput {
        associations: vec![
            pair("*.csv", "acme.grid"),
            pair("*.xlsx", "acme.grid"),
            pair("*.xlsx", "default"),
        ],
        ..input("/w/a.xlsx")
    };
    assert_eq!(chosen_type(&choose_viewer(&first)), Some("acme.grid"));
    let missing = ViewerChoiceInput {
        associations: vec![pair("*.xlsx", "gone.view")],
        ..input("/w/a.xlsx")
    };
    assert_eq!(
        choose_viewer(&missing),
        ViewerChoice {
            viewer: None,
            unavailable: true
        }
    );
}

#[test]
fn in_artifacts_a_default_viewer_beats_an_option_listed_before_it() {
    let list = vec![ext(
        "both",
        false,
        vec![
            kind("both.option", "O", "*.csv", ViewerPriority::Option, true),
            kind("both.default", "D", "*.csv", ViewerPriority::Default, true),
        ],
        true,
    )];
    let choice = choose_viewer(&ViewerChoiceInput {
        path: "/w/a.csv".to_owned(),
        options: viewer_options(Some("/w/a.csv"), &list),
        chosen: None,
        associations: Vec::new(),
        in_artifacts: true,
    });
    assert_eq!(chosen_type(&choice), Some("both.default"));
}

#[test]
fn the_association_pattern_of_a_name_without_a_suffix_keeps_the_name_and_its_case() {
    assert_eq!(association_pattern("Makefile"), "Makefile");
    assert_eq!(association_pattern("/w/a."), "*.");
    assert_eq!(association_pattern("/w/.gitignore"), ".gitignore");
    assert_eq!(association_pattern("/w/.a.B"), "*.b");
}
