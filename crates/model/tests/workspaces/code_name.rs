#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::HashSet;

use ostia_model::workspaces::code_name::code_name;

fn sequence(values: &[f64]) -> impl FnMut() -> f64 {
    let values = values.to_vec();
    let mut index = 0;
    move || {
        let value = values[index.min(values.len() - 1)];
        index += 1;
        value
    }
}

fn taken(names: &[&str]) -> HashSet<String> {
    names.iter().map(|name| (*name).to_owned()).collect()
}

#[test]
fn joins_an_adjective_and_a_noun_picked_by_the_random_source() {
    assert_eq!(code_name(&taken(&[]), sequence(&[0.0, 0.0])), "amber-acorn");
    assert_eq!(
        code_name(&taken(&[]), sequence(&[0.999, 0.999])),
        "zesty-yarrow"
    );
}

#[test]
fn draws_again_when_the_name_is_taken() {
    assert_eq!(
        code_name(
            &taken(&["amber-acorn"]),
            sequence(&[0.0, 0.0, 0.999, 0.999])
        ),
        "zesty-yarrow"
    );
}

#[test]
fn numbers_a_name_when_the_random_source_only_ever_repeats_a_taken_one() {
    assert_eq!(code_name(&taken(&["amber-acorn"]), || 0.0), "amber-acorn-2");
    assert_eq!(
        code_name(&taken(&["amber-acorn", "amber-acorn-2"]), || 0.0),
        "amber-acorn-3"
    );
}

#[test]
fn clamps_a_random_value_of_one_to_the_last_word_of_each_list() {
    assert_eq!(code_name(&taken(&[]), || 1.0), "zesty-yarrow");
}

#[test]
fn picks_the_middle_of_each_list_for_one_half() {
    assert_eq!(code_name(&taken(&[]), || 0.5), "lucky-lantern");
}
