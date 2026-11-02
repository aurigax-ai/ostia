use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use futures_util::future::BoxFuture;
use ostia_base::clock::Clock;
use ostia_base::error::io_error;
use ostia_base::{PaneId, WindowId};
use serde_json::Value;

use crate::app_log::{AppLog, LogFields, LogValue};
use crate::privacy_telemetry::{ErrorInput, ErrorSource, platform_name};
use crate::renderer_reports::{
    REPORT_WINDOW_MS, REPORTS_PER_WINDOW, RendererErrorKind, ReportLimiter, normalize_pane_ids,
    normalize_renderer_report,
};

const CRASH_RELOADS_PER_MINUTE: usize = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecoveryReason {
    Reload,
    RenderError,
    RendererGone,
}

impl RecoveryReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Reload => "reload",
            Self::RenderError => "render-error",
            Self::RendererGone => "renderer-gone",
        }
    }
}

pub trait ErrorTelemetry: Send + Sync {
    fn error(&self, input: ErrorInput);
}

pub trait WindowContents {
    fn window_id(&self) -> WindowId;
    fn is_destroyed(&self) -> bool;
    fn reload(&self);
    fn toggle_devtools(&self);
}

pub type StartRecovery = Arc<dyn Fn(&WindowId, RecoveryReason) + Send + Sync>;
pub type FinishRecovery = Arc<dyn Fn(&WindowId, &HashSet<PaneId>) + Send + Sync>;
pub type OpenPath = Arc<dyn Fn(&Path) -> BoxFuture<'static, String> + Send + Sync>;

pub struct DiagnosticsDeps {
    pub log: Arc<dyn AppLog>,
    pub telemetry: Arc<dyn ErrorTelemetry>,
    pub version: String,
    pub log_dir: PathBuf,
    pub test_hooks: bool,
    pub packaged: bool,
    pub now: Clock,
    pub start_recovery: StartRecovery,
    pub finish_recovery: FinishRecovery,
    pub open_path: OpenPath,
}

#[derive(Debug, Clone)]
pub struct MainError {
    pub name: String,
    pub message: String,
    pub stack: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ChildProcessGone {
    pub kind: String,
    pub reason: String,
    pub exit_code: i64,
    pub name: Option<String>,
    pub service_name: Option<String>,
}

struct Inner {
    deps: DiagnosticsDeps,
    reports: ReportLimiter,
    crash_reloads: ReportLimiter,
}

#[derive(Clone)]
pub struct Diagnostics {
    inner: Arc<Inner>,
}

pub struct WindowWatch {
    inner: Arc<Inner>,
    window: WindowId,
    loaded: AtomicBool,
}

fn fields(pairs: Vec<(&str, LogValue)>) -> LogFields {
    let mut out = LogFields::new();
    for (key, value) in pairs {
        out.insert(key, value);
    }
    out
}

fn source_of(kind: RendererErrorKind) -> ErrorSource {
    match kind {
        RendererErrorKind::Error => ErrorSource::RendererError,
        RendererErrorKind::Rejection => ErrorSource::RendererRejection,
        RendererErrorKind::Render => ErrorSource::RenderError,
        RendererErrorKind::Surface => ErrorSource::SurfaceError,
    }
}

fn base_name(source_id: &str) -> &str {
    source_id
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or_default()
}

fn error_fields(error: &MainError) -> LogFields {
    let mut out = fields(vec![("message", LogValue::from(error.message.as_str()))]);
    if let Some(stack) = &error.stack {
        out.insert("stack".to_owned(), LogValue::from(stack.as_str()));
    }
    out
}

impl Inner {
    fn allow_report(&self, key: &str, window: &WindowId) -> bool {
        let take = self.reports.take(key);
        if take.suppressed > 0 {
            self.deps.log.warn(
                "renderer-reports-suppressed",
                &fields(vec![
                    ("window", LogValue::from(window.as_str())),
                    ("suppressed", LogValue::from(take.suppressed)),
                ]),
            );
        }
        take.allowed
    }

    fn report_main(&self, event: &str, source: ErrorSource, error: &MainError) {
        self.deps.log.error(event, &error_fields(error));
        self.deps.telemetry.error(ErrorInput {
            source,
            name: error.name.clone(),
            message: error.message.clone(),
            stack: error.stack.clone(),
            extension: None,
        });
        tracing::error!(name = %error.name, event, "main process error");
    }
}

impl Diagnostics {
    pub fn new(deps: DiagnosticsDeps) -> Self {
        deps.log.info(
            "app-start",
            &fields(vec![
                ("version", LogValue::from(deps.version.as_str())),
                ("platform", LogValue::from(platform_name())),
                ("packaged", LogValue::from(deps.packaged)),
            ]),
        );
        let reports = ReportLimiter::new(REPORTS_PER_WINDOW, REPORT_WINDOW_MS, deps.now.clone());
        let crash_reloads =
            ReportLimiter::new(CRASH_RELOADS_PER_MINUTE, REPORT_WINDOW_MS, deps.now.clone());
        Self {
            inner: Arc::new(Inner {
                deps,
                reports,
                crash_reloads,
            }),
        }
    }

    pub fn main_uncaught_exception(&self, error: &MainError) {
        self.inner
            .report_main("main-uncaught-exception", ErrorSource::MainException, error);
    }

    pub fn main_unhandled_rejection(&self, error: &MainError) {
        self.inner.report_main(
            "main-unhandled-rejection",
            ErrorSource::MainRejection,
            error,
        );
    }

    pub fn child_process_gone(&self, gone: &ChildProcessGone) {
        let mut out = fields(vec![
            ("type", LogValue::from(gone.kind.as_str())),
            ("reason", LogValue::from(gone.reason.as_str())),
            ("exitCode", LogValue::from(gone.exit_code)),
        ]);
        if let Some(name) = &gone.name {
            out.insert("name".to_owned(), LogValue::from(name.as_str()));
        }
        if let Some(service) = &gone.service_name {
            out.insert("service".to_owned(), LogValue::from(service.as_str()));
        }
        self.inner.deps.log.warn("child-process-gone", &out);
    }

    pub fn guest_process_gone(&self, kind: &str, reason: &str, exit_code: i64) {
        if kind == "window" {
            return;
        }
        self.inner.deps.log.warn(
            "guest-process-gone",
            &fields(vec![
                ("type", LogValue::from(kind)),
                ("reason", LogValue::from(reason)),
                ("exitCode", LogValue::from(exit_code)),
            ]),
        );
    }

    pub fn handle_report(&self, window: &WindowId, raw: &Value) {
        let Some(report) = normalize_renderer_report(raw) else {
            return;
        };
        let deps = &self.inner.deps;
        if report.kind == RendererErrorKind::Render {
            (deps.start_recovery)(window, RecoveryReason::RenderError);
        }
        if !self.inner.allow_report(&format!("report:{window}"), window) {
            return;
        }
        let mut out = fields(vec![
            ("window", LogValue::from(window.as_str())),
            ("kind", LogValue::from(report.kind.as_str())),
            ("message", LogValue::from(report.message.as_str())),
        ]);
        if let Some(stack) = &report.stack {
            out.insert("stack".to_owned(), LogValue::from(stack.as_str()));
        }
        if let Some(source) = &report.source {
            out.insert("source".to_owned(), LogValue::from(source.as_str()));
        }
        deps.log.error("renderer-error", &out);
        deps.telemetry.error(ErrorInput {
            source: source_of(report.kind),
            name: "Error".to_owned(),
            message: report.message,
            stack: report.stack,
            extension: None,
        });
    }

    pub fn handle_ready(&self, window: &WindowId, raw: &Value) {
        if let Some(pane_ids) = normalize_pane_ids(raw) {
            (self.inner.deps.finish_recovery)(window, &pane_ids);
        }
    }

    pub fn reload_window(&self, contents: &dyn WindowContents) {
        if contents.is_destroyed() {
            return;
        }
        (self.inner.deps.start_recovery)(&contents.window_id(), RecoveryReason::Reload);
        contents.reload();
    }

    pub fn toggle_devtools(&self, contents: &dyn WindowContents) {
        if contents.is_destroyed() {
            return;
        }
        self.inner.deps.log.info(
            "devtools-toggled",
            &fields(vec![(
                "window",
                LogValue::from(contents.window_id().as_str()),
            )]),
        );
        contents.toggle_devtools();
    }

    pub async fn open_log_folder(&self) -> ostia_base::Result<bool> {
        let dir = &self.inner.deps.log_dir;
        std::fs::create_dir_all(dir).map_err(io_error(dir))?;
        Ok((self.inner.deps.open_path)(dir).await.is_empty())
    }

    pub fn test_hooks(&self) -> bool {
        self.inner.deps.test_hooks
    }

    pub fn watch_window(&self, window: &WindowId) -> WindowWatch {
        WindowWatch {
            inner: self.inner.clone(),
            window: window.clone(),
            loaded: AtomicBool::new(false),
        }
    }
}

impl WindowWatch {
    fn window_field(&self) -> (&'static str, LogValue) {
        ("window", LogValue::from(self.window.as_str()))
    }

    pub fn did_finish_load(&self) {
        self.loaded.store(true, Ordering::SeqCst);
    }

    pub fn did_start_navigation(&self, is_main_frame: bool, is_same_document: bool) {
        if !self.loaded.load(Ordering::SeqCst) || !is_main_frame || is_same_document {
            return;
        }
        self.inner
            .deps
            .log
            .info("window-reload", &fields(vec![self.window_field()]));
        (self.inner.deps.start_recovery)(&self.window, RecoveryReason::Reload);
    }

    pub fn did_fail_load(&self, code: i64, description: &str, main_frame: bool) {
        self.inner.deps.log.warn(
            "did-fail-load",
            &fields(vec![
                self.window_field(),
                ("code", LogValue::from(code)),
                ("description", LogValue::from(description)),
                ("mainFrame", LogValue::from(main_frame)),
            ]),
        );
    }

    pub fn render_process_gone(
        &self,
        reason: &str,
        exit_code: i64,
        window_destroyed: bool,
        contents: &dyn WindowContents,
    ) {
        let deps = &self.inner.deps;
        deps.log.error(
            "render-process-gone",
            &fields(vec![
                self.window_field(),
                ("reason", LogValue::from(reason)),
                ("exitCode", LogValue::from(exit_code)),
            ]),
        );
        if reason == "clean-exit" || window_destroyed {
            return;
        }
        deps.telemetry.error(ErrorInput {
            source: ErrorSource::RendererGone,
            name: "RendererGone".to_owned(),
            message: format!("{reason} ({exit_code})"),
            stack: None,
            extension: None,
        });
        (deps.start_recovery)(&self.window, RecoveryReason::RendererGone);
        if !self.inner.crash_reloads.take(self.window.as_str()).allowed {
            deps.log.error(
                "renderer-reload-skipped",
                &fields(vec![
                    self.window_field(),
                    ("reason", LogValue::from("crash-loop")),
                ]),
            );
            return;
        }
        deps.log
            .info("renderer-reload", &fields(vec![self.window_field()]));
        contents.reload();
    }

    pub fn console_message(&self, level: &str, message: &str, source_id: &str, line: i64) {
        if level != "error" {
            return;
        }
        if !self
            .inner
            .allow_report(&format!("console:{}", self.window), &self.window)
        {
            return;
        }
        let mut out = fields(vec![
            self.window_field(),
            ("message", LogValue::from(message)),
        ]);
        if !source_id.is_empty() {
            out.insert(
                "source".to_owned(),
                LogValue::from(format!("{}:{line}", base_name(source_id))),
            );
        }
        self.inner.deps.log.error("renderer-console-error", &out);
    }

    pub fn unresponsive(&self) {
        self.inner
            .deps
            .log
            .warn("window-unresponsive", &fields(vec![self.window_field()]));
    }

    pub fn responsive(&self) {
        self.inner
            .deps
            .log
            .info("window-responsive", &fields(vec![self.window_field()]));
    }

    pub fn closed(&self) {
        self.inner
            .reports
            .forget(&format!("report:{}", self.window));
        self.inner
            .reports
            .forget(&format!("console:{}", self.window));
        self.inner.crash_reloads.forget(self.window.as_str());
    }
}
