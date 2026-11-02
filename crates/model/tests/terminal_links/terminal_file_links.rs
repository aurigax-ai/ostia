#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::future::BoxFuture;
use ostia_contract::file_links::find_file_links;
use ostia_model::settings::terminal_pane_settings::LinkClick;
use ostia_model::terminal::ostia_terminal::{TerminalPosition, TerminalRange};
use ostia_model::terminal_links::link_modifier::{
    PathLinkClick, PathLinkContext, PathLinkTarget, path_link_target,
};
use ostia_model::terminal_links::terminal_file_links::{
    BufferCell, BufferRow, FileLinkAction, FileLinkDeps, FileLinkFacts, FileLinkTarget, OfferFacts,
    PathKind, TerminalBuffer, TerminalLink, create_file_link_provider, file_link_action,
    matches_on_row, path_link_offers, read_logical_line,
};

struct FakeTerminal(Vec<BufferRow>);

impl TerminalBuffer for FakeTerminal {
    fn len(&self) -> usize {
        self.0.len()
    }

    fn line(&self, y: usize) -> Option<BufferRow> {
        self.0.get(y).cloned()
    }
}

fn build_row(text: &str, wrapped: bool, wide: &[usize]) -> BufferRow {
    let mut cells: Vec<BufferCell> = Vec::new();
    for ch in text.chars() {
        let is_wide = wide.contains(&cells.len());
        cells.push(BufferCell {
            chars: ch.to_string(),
            width: if is_wide { 2 } else { 1 },
        });
        if is_wide {
            cells.push(BufferCell {
                chars: String::new(),
                width: 0,
            });
        }
    }
    BufferRow { wrapped, cells }
}

fn row(text: &str) -> BufferRow {
    build_row(text, false, &[])
}

fn wrapped(text: &str) -> BufferRow {
    build_row(text, true, &[])
}

fn terminal(rows: Vec<BufferRow>) -> Arc<FakeTerminal> {
    Arc::new(FakeTerminal(rows))
}

fn pos(x: i64, y: i64) -> TerminalPosition {
    TerminalPosition { x, y }
}

fn range(start: TerminalPosition, end: TerminalPosition) -> TerminalRange {
    TerminalRange { start, end }
}

type Opened = (PathLinkTarget, FileLinkAction, FileLinkTarget);
type Hovered = (TerminalRange, FileLinkAction, Vec<PathLinkTarget>);

struct Spies {
    stat_calls: Mutex<Vec<String>>,
    stat_answer: Mutex<Option<PathKind>>,
    probe_calls: Mutex<Vec<String>>,
    opened: Mutex<Vec<Opened>>,
    hovered: Mutex<Vec<Hovered>>,
    left: AtomicUsize,
}

impl Spies {
    fn new(stat_answer: Option<PathKind>) -> Arc<Self> {
        Arc::new(Self {
            stat_calls: Mutex::new(Vec::new()),
            stat_answer: Mutex::new(stat_answer),
            probe_calls: Mutex::new(Vec::new()),
            opened: Mutex::new(Vec::new()),
            hovered: Mutex::new(Vec::new()),
            left: AtomicUsize::new(0),
        })
    }

    fn stat_calls(&self) -> Vec<String> {
        self.stat_calls.lock().unwrap().clone()
    }

    fn probe_calls(&self) -> Vec<String> {
        self.probe_calls.lock().unwrap().clone()
    }

    fn opened(&self) -> Vec<Opened> {
        self.opened.lock().unwrap().clone()
    }

    fn hovered(&self) -> Vec<Hovered> {
        self.hovered.lock().unwrap().clone()
    }
}

fn linux_target(click: PathLinkClick) -> Option<PathLinkTarget> {
    path_link_target(
        click,
        PathLinkContext {
            mac: false,
            link_click: LinkClick::App,
        },
    )
}

fn answer(kind: Option<PathKind>) -> BoxFuture<'static, Option<PathKind>> {
    Box::pin(async move { kind })
}

fn base_deps(spies: &Arc<Spies>) -> FileLinkDeps {
    FileLinkDeps {
        cwd: Box::new(|| Some("/home/u/proj".to_owned())),
        remote: Box::new(|| false),
        confined_only: Box::new(|| false),
        revealable: Box::new(|_| false),
        stat: {
            let spies = spies.clone();
            Box::new(move |path| {
                spies.stat_calls.lock().unwrap().push(path);
                answer(*spies.stat_answer.lock().unwrap())
            })
        },
        probe: {
            let spies = spies.clone();
            Box::new(move |written| {
                spies.probe_calls.lock().unwrap().push(written);
                answer(None)
            })
        },
        activate: {
            let spies = spies.clone();
            Box::new(move |how, action, target| {
                spies.opened.lock().unwrap().push((how, action, target));
            })
        },
        target: Box::new(linux_target),
        hover: {
            let spies = spies.clone();
            Box::new(move |range, action, offers| {
                spies.hovered.lock().unwrap().push((range, action, offers));
            })
        },
        leave: {
            let spies = spies.clone();
            Box::new(move || {
                spies.left.fetch_add(1, Ordering::SeqCst);
            })
        },
    }
}

async fn links_in(
    term: &Arc<FakeTerminal>,
    row: i64,
    deps: FileLinkDeps,
) -> Option<Vec<TerminalLink>> {
    create_file_link_provider(term.clone(), deps)
        .provide_links(row)
        .await
}

fn ctrl() -> PathLinkClick {
    PathLinkClick {
        ctrl: true,
        ..PathLinkClick::default()
    }
}

fn target_of(written: &str, path: &str, line: Option<u64>) -> FileLinkTarget {
    FileLinkTarget {
        written: written.to_owned(),
        path: path.to_owned(),
        line,
        column: None,
    }
}

#[test]
fn joins_wrapped_rows_and_maps_each_character_to_its_cell_skipping_wide_char_spacers() {
    let term = FakeTerminal(vec![build_row("字ab", false, &[0]), wrapped("cd")]);
    let line = read_logical_line(&term, 2);
    assert_eq!(line.text, "字abcd");
    assert_eq!(
        line.cells,
        [pos(1, 1), pos(3, 1), pos(4, 1), pos(1, 2), pos(2, 2)]
    );
}

#[test]
fn reads_an_empty_cell_as_a_space() {
    let mut cells = row("a b").cells;
    cells[1].chars = String::new();
    let term = FakeTerminal(vec![BufferRow {
        wrapped: false,
        cells,
    }]);
    let line = read_logical_line(&term, 1);
    assert_eq!(line.text, "a b");
    assert_eq!(line.cells, [pos(1, 1), pos(2, 1), pos(3, 1)]);
}

#[test]
fn keeps_only_the_matches_that_touch_the_row() {
    let term = FakeTerminal(vec![row("see src/a.ts "), wrapped("src/b.ts")]);
    let line = read_logical_line(&term, 1);
    let matches = find_file_links(&line.text);
    assert_eq!(matches.len(), 2);
    let first = matches_on_row(matches.clone(), &line.cells, 1);
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].path, "src/a.ts");
    let second = matches_on_row(matches, &line.cells, 2);
    assert_eq!(second.len(), 1);
    assert_eq!(second[0].path, "src/b.ts");
}

#[tokio::test(start_paused = true)]
async fn slices_the_link_text_by_utf16_units_after_an_emoji() {
    let term = terminal(vec![build_row("😀 src/app.ts", false, &[0])]);
    let links = links_in(&term, 1, base_deps(&Spies::new(Some(PathKind::File))))
        .await
        .unwrap();
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].text, "src/app.ts");
    assert_eq!(links[0].range, range(pos(4, 1), pos(13, 1)));
}

#[tokio::test(start_paused = true)]
async fn links_an_existing_file_across_a_wrapped_row_and_opens_it_at_its_line_on_ctrl_click() {
    let term = terminal(vec![row("error in src/ap"), wrapped("p.ts:12:4 here")]);
    let spies = Spies::new(Some(PathKind::File));
    let links = links_in(&term, 2, base_deps(&spies)).await.unwrap();
    assert_eq!(spies.stat_calls(), ["/home/u/proj/src/app.ts"]);
    assert_eq!(links.len(), 1);
    let link = &links[0];
    assert_eq!(link.text, "src/app.ts:12:4");
    assert_eq!(link.range, range(pos(10, 1), pos(9, 2)));
    assert!(link.decorations.pointer_cursor);

    link.activate(PathLinkClick::default(), false);
    assert!(spies.opened().is_empty());
    link.activate(ctrl(), false);
    assert_eq!(
        spies.opened(),
        [(
            PathLinkTarget::Open,
            FileLinkAction::OpenFile,
            FileLinkTarget {
                written: "src/app.ts".to_owned(),
                path: "/home/u/proj/src/app.ts".to_owned(),
                line: Some(12),
                column: Some(4),
            }
        )]
    );
}

#[tokio::test(start_paused = true)]
async fn reports_the_hovered_link_range_and_when_the_pointer_leaves_it() {
    let term = terminal(vec![row("see src/app.ts now")]);
    let spies = Spies::new(Some(PathKind::File));
    let links = links_in(&term, 1, base_deps(&spies)).await.unwrap();
    links[0].hover();
    assert_eq!(
        spies.hovered(),
        [(
            range(pos(5, 1), pos(14, 1)),
            FileLinkAction::OpenFile,
            vec![
                PathLinkTarget::Open,
                PathLinkTarget::OpenSystem,
                PathLinkTarget::ShowSystem
            ]
        )]
    );
    links[0].leave();
    assert_eq!(spies.left.load(Ordering::SeqCst), 1);
}

#[tokio::test(start_paused = true)]
async fn ssh_c37_offers_no_local_file_link_while_the_pane_is_in_a_remote_shell() {
    let term = terminal(vec![row("error in src/app.ts:12")]);
    let spies = Spies::new(Some(PathKind::File));
    let mut deps = base_deps(&spies);
    deps.remote = Box::new(|| true);
    assert!(links_in(&term, 1, deps).await.is_none());
    assert!(spies.stat_calls().is_empty());
}

#[tokio::test(start_paused = true)]
async fn offers_no_link_for_a_path_that_is_not_an_existing_file() {
    let term = terminal(vec![row("see missing/file.ts")]);
    let spies = Spies::new(None);
    assert!(links_in(&term, 1, base_deps(&spies)).await.is_none());
}

#[tokio::test(start_paused = true)]
async fn asks_again_about_a_path_only_after_five_seconds_so_a_file_made_since_then_gets_its_link() {
    let term = terminal(vec![row("wrote out/report.txt")]);
    let spies = Spies::new(None);
    let provider = create_file_link_provider(term.clone(), base_deps(&spies));

    assert!(provider.provide_links(1).await.is_none());
    *spies.stat_answer.lock().unwrap() = Some(PathKind::File);
    tokio::time::advance(Duration::from_millis(4_900)).await;
    assert!(provider.provide_links(1).await.is_none());
    assert_eq!(spies.stat_calls().len(), 1);

    tokio::time::advance(Duration::from_millis(200)).await;
    assert_eq!(provider.provide_links(1).await.unwrap().len(), 1);
    assert_eq!(spies.stat_calls().len(), 2);
}

#[tokio::test(start_paused = true)]
async fn forgets_the_paths_asked_about_longest_ago_once_it_holds_five_hundred() {
    let rows = (0..501).map(|i| row(&format!("file{i}.ts"))).collect();
    let term = terminal(rows);
    let spies = Spies::new(Some(PathKind::File));
    let provider = create_file_link_provider(term.clone(), base_deps(&spies));

    provider.provide_links(1).await;
    provider.provide_links(1).await;
    assert_eq!(spies.stat_calls().len(), 1);

    for row in 2..=501 {
        provider.provide_links(row).await;
    }
    spies.stat_calls.lock().unwrap().clear();
    provider.provide_links(501).await;
    assert!(spies.stat_calls().is_empty());
    provider.provide_links(1).await;
    assert_eq!(spies.stat_calls(), ["/home/u/proj/file0.ts"]);
}

fn facts() -> FileLinkFacts {
    FileLinkFacts {
        confined: None,
        probed: None,
        revealable: false,
        confined_only: false,
    }
}

mod file_link_action_cases {
    use super::*;

    #[test]
    fn opens_a_file_the_confined_stat_sees_and_admits_one_only_main_can_see() {
        assert_eq!(
            file_link_action(&FileLinkFacts {
                confined: Some(PathKind::File),
                ..facts()
            }),
            Some(FileLinkAction::OpenFile)
        );
        assert_eq!(
            file_link_action(&FileLinkFacts {
                probed: Some(PathKind::File),
                ..facts()
            }),
            Some(FileLinkAction::AdmitFile)
        );
    }

    #[test]
    fn reveals_a_folder_under_the_files_root_and_hands_any_other_folder_to_the_file_manager() {
        assert_eq!(
            file_link_action(&FileLinkFacts {
                confined: Some(PathKind::Dir),
                revealable: true,
                ..facts()
            }),
            Some(FileLinkAction::RevealFolder)
        );
        assert_eq!(
            file_link_action(&FileLinkFacts {
                confined: Some(PathKind::Dir),
                ..facts()
            }),
            Some(FileLinkAction::OpenFolder)
        );
        assert_eq!(
            file_link_action(&FileLinkFacts {
                probed: Some(PathKind::Dir),
                ..facts()
            }),
            Some(FileLinkAction::OpenFolder)
        );
    }

    #[test]
    fn leaves_a_path_that_is_neither_a_file_nor_a_folder_as_plain_text() {
        assert_eq!(file_link_action(&facts()), None);
    }

    #[test]
    fn in_a_sandboxed_or_scratch_workspace_offers_only_what_stays_inside_the_app() {
        let confined_only = FileLinkFacts {
            confined_only: true,
            ..facts()
        };
        assert_eq!(
            file_link_action(&FileLinkFacts {
                confined: Some(PathKind::File),
                ..confined_only
            }),
            Some(FileLinkAction::OpenFile)
        );
        assert_eq!(
            file_link_action(&FileLinkFacts {
                confined: Some(PathKind::Dir),
                revealable: true,
                ..confined_only
            }),
            Some(FileLinkAction::RevealFolder)
        );
        assert_eq!(
            file_link_action(&FileLinkFacts {
                confined: Some(PathKind::Dir),
                ..confined_only
            }),
            None
        );
        assert_eq!(
            file_link_action(&FileLinkFacts {
                probed: Some(PathKind::File),
                ..confined_only
            }),
            None
        );
        assert_eq!(
            file_link_action(&FileLinkFacts {
                probed: Some(PathKind::Dir),
                ..confined_only
            }),
            None
        );
    }
}

mod outside_home_and_folders {
    use super::*;

    fn deps_with_probe(spies: &Arc<Spies>, probe: Option<PathKind>) -> FileLinkDeps {
        let mut deps = base_deps(spies);
        deps.probe = {
            let spies = spies.clone();
            Box::new(move |written| {
                spies.probe_calls.lock().unwrap().push(written);
                answer(probe)
            })
        };
        deps
    }

    #[tokio::test(start_paused = true)]
    async fn asks_main_about_an_absolute_path_the_confined_stat_cannot_see_and_admits_it_on_a_human_ctrl_click()
     {
        let term = terminal(vec![row("saved /tmp/shots/a.png:3")]);
        let spies = Spies::new(None);
        let links = links_in(&term, 1, deps_with_probe(&spies, Some(PathKind::File)))
            .await
            .unwrap();
        assert_eq!(spies.probe_calls(), ["/tmp/shots/a.png"]);
        links[0].hover();
        assert_eq!(spies.hovered()[0].1, FileLinkAction::AdmitFile);

        links[0].activate(ctrl(), true);
        assert_eq!(
            spies.opened(),
            [(
                PathLinkTarget::Open,
                FileLinkAction::AdmitFile,
                target_of("/tmp/shots/a.png", "/tmp/shots/a.png", Some(3))
            )]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn never_admits_a_file_or_opens_the_file_manager_for_a_click_the_human_did_not_make() {
        for kind in [PathKind::File, PathKind::Dir] {
            let term = terminal(vec![row("see /tmp/out")]);
            let spies = Spies::new(None);
            let links = links_in(&term, 1, deps_with_probe(&spies, Some(kind)))
                .await
                .unwrap();
            links[0].activate(ctrl(), false);
            assert!(spies.opened().is_empty(), "{kind:?}");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn never_asks_main_while_the_pane_is_remote_sandboxed_or_scratch_or_for_a_path_under_home()
     {
        let term = terminal(vec![row("see /tmp/out.txt")]);

        let spies = Spies::new(None);
        let mut remote = deps_with_probe(&spies, Some(PathKind::File));
        remote.remote = Box::new(|| true);
        assert!(links_in(&term, 1, remote).await.is_none());

        let spies = Spies::new(None);
        let mut sandboxed = deps_with_probe(&spies, Some(PathKind::File));
        sandboxed.confined_only = Box::new(|| true);
        assert!(links_in(&term, 1, sandboxed).await.is_none());
        assert!(spies.probe_calls().is_empty());

        let spies = Spies::new(None);
        let mut no_cwd = deps_with_probe(&spies, Some(PathKind::File));
        no_cwd.cwd = Box::new(|| None);
        assert_eq!(links_in(&term, 1, no_cwd).await.unwrap().len(), 1);

        let spies = Spies::new(None);
        let home_term = terminal(vec![row("see ~/gone.txt")]);
        let home = deps_with_probe(&spies, Some(PathKind::File));
        assert!(links_in(&home_term, 1, home).await.is_none());
        assert!(spies.probe_calls().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn does_not_act_on_a_link_whose_pane_turned_remote_after_it_was_drawn() {
        let remote = Arc::new(AtomicBool::new(false));
        let term = terminal(vec![row("see src/app.ts")]);
        let spies = Spies::new(Some(PathKind::File));
        let mut deps = base_deps(&spies);
        deps.remote = {
            let remote = remote.clone();
            Box::new(move || remote.load(Ordering::SeqCst))
        };
        let links = links_in(&term, 1, deps).await.unwrap();
        remote.store(true, Ordering::SeqCst);
        links[0].activate(ctrl(), true);
        assert!(spies.opened().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn links_a_folder_and_says_whether_a_click_reveals_it_in_files_or_opens_the_file_manager()
    {
        let term = terminal(vec![row("built src/renderer/ ok")]);

        let spies = Spies::new(Some(PathKind::Dir));
        let mut inside = base_deps(&spies);
        inside.revealable = Box::new(|_| true);
        let links = links_in(&term, 1, inside).await.unwrap();
        assert_eq!(links[0].text, "src/renderer");
        links[0].hover();
        assert_eq!(spies.hovered()[0].1, FileLinkAction::RevealFolder);
        links[0].activate(ctrl(), false);
        assert_eq!(
            spies.opened(),
            [(
                PathLinkTarget::Open,
                FileLinkAction::RevealFolder,
                target_of("src/renderer", "/home/u/proj/src/renderer", None)
            )]
        );

        let spies = Spies::new(Some(PathKind::Dir));
        let links = links_in(&term, 1, base_deps(&spies)).await.unwrap();
        links[0].hover();
        assert_eq!(spies.hovered()[0].1, FileLinkAction::OpenFolder);
        links[0].activate(ctrl(), true);
        assert_eq!(
            spies.opened(),
            [(
                PathLinkTarget::Open,
                FileLinkAction::OpenFolder,
                target_of("src/renderer", "/home/u/proj/src/renderer", None)
            )]
        );
    }
}

mod path_link_offers_cases {
    use super::*;

    fn offers(
        action: FileLinkAction,
        confined: Option<PathKind>,
        confined_only: bool,
        in_tree: bool,
    ) -> Vec<PathLinkTarget> {
        path_link_offers(
            action,
            OfferFacts {
                confined,
                confined_only,
            },
            in_tree,
        )
    }

    #[test]
    fn offers_the_default_app_and_the_file_manager_unless_the_workspace_is_sandboxed_or_scratch() {
        assert_eq!(
            offers(FileLinkAction::OpenFile, Some(PathKind::File), false, false),
            [
                PathLinkTarget::Open,
                PathLinkTarget::OpenSystem,
                PathLinkTarget::ShowSystem
            ]
        );
        assert_eq!(
            offers(FileLinkAction::OpenFile, Some(PathKind::File), true, true),
            [PathLinkTarget::Open, PathLinkTarget::Show]
        );
    }

    #[test]
    fn offers_show_in_files_only_for_a_path_inside_the_files_tree_never_as_a_fallback() {
        assert_eq!(
            offers(FileLinkAction::OpenFile, Some(PathKind::File), false, true),
            [
                PathLinkTarget::Open,
                PathLinkTarget::OpenSystem,
                PathLinkTarget::Show,
                PathLinkTarget::ShowSystem
            ]
        );
        assert_eq!(
            offers(FileLinkAction::AdmitFile, None, false, true),
            [
                PathLinkTarget::Open,
                PathLinkTarget::OpenSystem,
                PathLinkTarget::ShowSystem
            ]
        );
    }

    #[test]
    fn never_offers_a_second_chord_for_what_a_folder_link_already_does() {
        assert_eq!(
            offers(
                FileLinkAction::RevealFolder,
                Some(PathKind::Dir),
                false,
                true
            ),
            [
                PathLinkTarget::Open,
                PathLinkTarget::OpenSystem,
                PathLinkTarget::ShowSystem
            ]
        );
        assert_eq!(
            offers(FileLinkAction::OpenFolder, None, false, false),
            [PathLinkTarget::Open, PathLinkTarget::ShowSystem]
        );
    }
}

mod modifier_clicks {
    use super::*;

    fn click(ctrl: bool, shift: bool, alt: bool) -> PathLinkClick {
        PathLinkClick {
            ctrl,
            shift,
            alt,
            ..PathLinkClick::default()
        }
    }

    #[tokio::test(start_paused = true)]
    async fn opens_with_the_default_app_on_ctrl_shift_and_shows_the_folder_on_ctrl_alt_with_shift_for_the_file_manager()
     {
        let term = terminal(vec![row("see src/report.xlsx")]);
        let spies = Spies::new(Some(PathKind::File));
        let mut deps = base_deps(&spies);
        deps.revealable = Box::new(|_| true);
        let links = links_in(&term, 1, deps).await.unwrap();
        let target = target_of("src/report.xlsx", "/home/u/proj/src/report.xlsx", None);

        links[0].activate(click(true, true, false), true);
        assert_eq!(
            spies.opened().last().unwrap(),
            &(
                PathLinkTarget::OpenSystem,
                FileLinkAction::OpenFile,
                target.clone()
            )
        );
        links[0].activate(click(true, false, true), true);
        assert_eq!(
            spies.opened().last().unwrap(),
            &(
                PathLinkTarget::Show,
                FileLinkAction::OpenFile,
                target.clone()
            )
        );
        links[0].activate(click(true, true, true), true);
        assert_eq!(
            spies.opened().last().unwrap(),
            &(PathLinkTarget::ShowSystem, FileLinkAction::OpenFile, target)
        );
    }

    #[tokio::test(start_paused = true)]
    async fn follows_terminal_link_click_which_swaps_shift() {
        let term = terminal(vec![row("see src/report.xlsx")]);
        let spies = Spies::new(Some(PathKind::File));
        let mut deps = base_deps(&spies);
        deps.revealable = Box::new(|_| true);
        deps.target = Box::new(|click| {
            path_link_target(
                click,
                PathLinkContext {
                    mac: false,
                    link_click: LinkClick::System,
                },
            )
        });
        let links = links_in(&term, 1, deps).await.unwrap();
        links[0].activate(click(true, false, false), true);
        assert_eq!(spies.opened()[0].0, PathLinkTarget::OpenSystem);
        links[0].activate(click(true, true, false), true);
        assert_eq!(spies.opened()[1].0, PathLinkTarget::Open);
    }

    #[tokio::test(start_paused = true)]
    async fn does_nothing_for_an_action_the_link_does_not_offer_files_outside_the_tree_the_system_in_a_sandbox()
     {
        let term = terminal(vec![row("see src/report.xlsx")]);

        let spies = Spies::new(Some(PathKind::File));
        let outside = links_in(&term, 1, base_deps(&spies)).await.unwrap();
        outside[0].activate(click(true, false, true), true);
        assert!(spies.opened().is_empty());

        let spies = Spies::new(Some(PathKind::File));
        let mut deps = base_deps(&spies);
        deps.confined_only = Box::new(|| true);
        deps.revealable = Box::new(|_| true);
        let sandboxed = links_in(&term, 1, deps).await.unwrap();
        sandboxed[0].activate(click(true, true, false), true);
        sandboxed[0].activate(click(true, true, true), true);
        assert!(spies.opened().is_empty());
        sandboxed[0].activate(click(true, false, true), true);
        let opened = spies.opened();
        assert_eq!(opened.len(), 1);
        assert_eq!(opened[0].0, PathLinkTarget::Show);
        assert_eq!(opened[0].1, FileLinkAction::OpenFile);
    }

    #[tokio::test(start_paused = true)]
    async fn never_hands_a_file_to_the_system_for_a_click_the_human_did_not_make() {
        let term = terminal(vec![row("see src/report.xlsx")]);
        let spies = Spies::new(Some(PathKind::File));
        let links = links_in(&term, 1, base_deps(&spies)).await.unwrap();
        links[0].activate(click(true, true, false), false);
        links[0].activate(click(true, true, true), false);
        assert!(spies.opened().is_empty());
    }
}
