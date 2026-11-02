use ostia_ui::components::WorkspaceState;

pub struct FixtureWorkspace {
    pub title: &'static str,
    pub state: WorkspaceState,
    pub folder: &'static str,
}

pub fn fixture_workspaces() -> &'static [FixtureWorkspace] {
    const ROWS: &[FixtureWorkspace] = &[
        FixtureWorkspace {
            title: "Fixture: working",
            state: WorkspaceState::Working,
            folder: "fixture",
        },
        FixtureWorkspace {
            title: "Fixture: waiting",
            state: WorkspaceState::Waiting,
            folder: "fixture",
        },
        FixtureWorkspace {
            title: "Fixture: failed",
            state: WorkspaceState::Error,
            folder: "fixture",
        },
        FixtureWorkspace {
            title: "Fixture: done",
            state: WorkspaceState::Done,
            folder: "fixture",
        },
    ];
    ROWS
}
