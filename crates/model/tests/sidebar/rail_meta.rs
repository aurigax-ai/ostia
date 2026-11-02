#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_model::sidebar::rail_meta::{FitInput, fit_count, path_candidates, shorten_path};

fn fit(widths: &[f64], available: f64, first_min: Option<f64>) -> usize {
    fit_count(&FitInput {
        widths: widths.to_vec(),
        available,
        gap: 8.0,
        more_width: 20.0,
        first_min,
    })
}

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| (*s).to_owned()).collect()
}

#[test]
fn drops_middle_segments_one_at_a_time_and_keeps_the_last_segment() {
    assert_eq!(
        path_candidates("~/Personal/goji/avail"),
        strings(&[
            "~/Personal/goji/avail",
            "~/…/goji/avail",
            "~/…/avail",
            "avail"
        ])
    );
}

#[test]
fn keeps_the_root_of_an_absolute_path() {
    assert_eq!(
        path_candidates("/srv/www/app"),
        strings(&["/srv/www/app", "/…/www/app", "/…/app", "app"])
    );
}

#[test]
fn offers_only_shorter_forms_than_the_full_path() {
    assert_eq!(path_candidates("~/a/b"), strings(&["~/a/b", "b"]));
    assert_eq!(path_candidates("~"), strings(&["~"]));
    assert_eq!(path_candidates("/"), strings(&["/"]));
}

#[test]
fn returns_the_full_path_when_it_fits() {
    let path = "~/Personal/goji/avail";
    assert_eq!(shorten_path(path, 40), path);
    assert_eq!(shorten_path(path, path.chars().count()), path);
}

#[test]
fn ellipsizes_from_the_middle_never_to_a_bare_head() {
    let path = "~/Personal/goji/avail";
    assert_eq!(shorten_path(path, 16), "~/…/goji/avail");
    assert_eq!(shorten_path(path, 10), "~/…/avail");
    assert_eq!(shorten_path(path, 6), "avail");
}

#[test]
fn falls_back_to_the_last_segment_when_nothing_fits() {
    assert_eq!(shorten_path("~/Personal/goji/avail", 0), "avail");
}

#[test]
fn shows_every_item_when_they_all_fit() {
    assert_eq!(fit(&[40.0, 40.0], 88.0, None), 2);
}

#[test]
fn leaves_room_for_the_more_button_when_items_overflow() {
    let widths = [40.0; 6];
    assert_eq!(fit(&widths, 160.0, None), 2);
    assert_eq!(fit(&widths, 188.0, None), 3);
}

#[test]
fn always_keeps_the_first_item_which_then_truncates() {
    assert_eq!(fit(&[200.0, 40.0], 100.0, None), 1);
    assert_eq!(fit(&[200.0], 100.0, None), 1);
}

#[test]
fn lets_the_first_item_shrink_to_its_minimum_before_hiding_any_item() {
    let widths = [200.0, 40.0];
    assert_eq!(fit(&widths, 120.0, None), 1);
    assert_eq!(fit(&widths, 120.0, Some(64.0)), 2);
    assert_eq!(fit(&widths, 120.0, Some(80.0)), 1);
}

#[test]
fn shows_nothing_for_no_items() {
    assert_eq!(fit(&[], 100.0, None), 0);
}
