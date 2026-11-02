pub struct PlaybookExtraFile {
    pub path: &'static str,
    pub text: &'static str,
}

pub const ONBOARD_TEXT: &str =
    include_str!("../../../src/shared/agents/playbooks/onboard/SKILL.md");

pub const ONBOARD_FILES: &[PlaybookExtraFile] = &[
    PlaybookExtraFile {
        path: "steps/cleanup.md",
        text: include_str!("../../../src/shared/agents/playbooks/onboard/steps/cleanup.md"),
    },
    PlaybookExtraFile {
        path: "steps/dispatch.md",
        text: include_str!("../../../src/shared/agents/playbooks/onboard/steps/dispatch.md"),
    },
    PlaybookExtraFile {
        path: "steps/issue.md",
        text: include_str!("../../../src/shared/agents/playbooks/onboard/steps/issue.md"),
    },
    PlaybookExtraFile {
        path: "steps/limits.md",
        text: include_str!("../../../src/shared/agents/playbooks/onboard/steps/limits.md"),
    },
    PlaybookExtraFile {
        path: "steps/merge.md",
        text: include_str!("../../../src/shared/agents/playbooks/onboard/steps/merge.md"),
    },
    PlaybookExtraFile {
        path: "steps/name.md",
        text: include_str!("../../../src/shared/agents/playbooks/onboard/steps/name.md"),
    },
    PlaybookExtraFile {
        path: "steps/pr.md",
        text: include_str!("../../../src/shared/agents/playbooks/onboard/steps/pr.md"),
    },
    PlaybookExtraFile {
        path: "steps/report.md",
        text: include_str!("../../../src/shared/agents/playbooks/onboard/steps/report.md"),
    },
    PlaybookExtraFile {
        path: "steps/review.md",
        text: include_str!("../../../src/shared/agents/playbooks/onboard/steps/review.md"),
    },
    PlaybookExtraFile {
        path: "steps/scout.md",
        text: include_str!("../../../src/shared/agents/playbooks/onboard/steps/scout.md"),
    },
    PlaybookExtraFile {
        path: "steps/test.md",
        text: include_str!("../../../src/shared/agents/playbooks/onboard/steps/test.md"),
    },
    PlaybookExtraFile {
        path: "steps/watch.md",
        text: include_str!("../../../src/shared/agents/playbooks/onboard/steps/watch.md"),
    },
    PlaybookExtraFile {
        path: "steps/worktree.md",
        text: include_str!("../../../src/shared/agents/playbooks/onboard/steps/worktree.md"),
    },
];
