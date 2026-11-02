#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;

use futures_util::future::BoxFuture;
use ostia_diagnostics::app_log::{AppLog, LogFields};
use ostia_diagnostics::gpu_report::{
    GpuDevice, GpuFeatureStatus, GpuInfo, GpuReport, GpuSource, gpu_facts,
};
use parking_lot::Mutex;
use serde_json::json;

#[derive(Default)]
struct Lines {
    seen: Mutex<Vec<(String, String, LogFields)>>,
}

impl Lines {
    fn at(&self, level: &str) -> Vec<(String, LogFields)> {
        self.seen
            .lock()
            .iter()
            .filter(|(seen, _, _)| seen == level)
            .map(|(_, event, fields)| (event.clone(), fields.clone()))
            .collect()
    }
}

impl AppLog for Lines {
    fn info(&self, event: &str, fields: &LogFields) {
        self.seen
            .lock()
            .push(("info".into(), event.into(), fields.clone()));
    }

    fn warn(&self, event: &str, fields: &LogFields) {
        self.seen
            .lock()
            .push(("warn".into(), event.into(), fields.clone()));
    }

    fn error(&self, event: &str, fields: &LogFields) {
        self.seen
            .lock()
            .push(("error".into(), event.into(), fields.clone()));
    }
}

struct FakeSource {
    info: Result<GpuInfo, String>,
}

impl GpuSource for FakeSource {
    fn info(&self) -> BoxFuture<'_, Result<GpuInfo, String>> {
        Box::pin(async move { self.info.clone() })
    }

    fn feature_status(&self) -> GpuFeatureStatus {
        GpuFeatureStatus {
            gpu_compositing: Some("enabled".to_owned()),
            ..GpuFeatureStatus::default()
        }
    }
}

fn registered(info: Result<GpuInfo, String>) -> (GpuReport, Arc<Lines>) {
    let log = Arc::new(Lines::default());
    let report = GpuReport::new(log.clone(), Arc::new(FakeSource { info }));
    (report, log)
}

#[tokio::test]
async fn gpu_u1_logs_once_the_gpu_process_has_reported_never_at_ready_when_every_feature_reads_software()
 {
    let (report, log) = registered(Ok(GpuInfo::default()));
    tokio::task::yield_now().await;
    assert!(log.at("info").is_empty());

    report.gpu_info_updated().await;
    let logged = log.at("info");
    assert_eq!(logged.len(), 1);
    assert_eq!(logged[0].0, "gpu-info");
    assert_eq!(logged[0].1["gpuCompositing"], json!("enabled"));
}

#[test]
fn names_the_renderer_the_active_device_and_the_feature_states_without_user_content() {
    let facts = gpu_facts(
        &GpuFeatureStatus {
            webgl: Some("enabled".to_owned()),
            gpu_compositing: Some("enabled".to_owned()),
            rasterization: Some("disabled_software".to_owned()),
            ..GpuFeatureStatus::default()
        },
        &GpuInfo {
            gpu_device: vec![
                GpuDevice {
                    active: false,
                    vendor_id: Some(0x8086),
                    device_id: Some(0xa7a0),
                    ..GpuDevice::default()
                },
                GpuDevice {
                    active: true,
                    vendor_id: Some(0x8086),
                    device_id: Some(0x56a5),
                    ..GpuDevice::default()
                },
            ],
            gl_renderer: Some("ANGLE (Intel, Mesa Intel(R) Arc(tm) A370M)".to_owned()),
            ..GpuInfo::default()
        },
    );
    assert_eq!(
        facts["glRenderer"],
        json!("ANGLE (Intel, Mesa Intel(R) Arc(tm) A370M)")
    );
    assert_eq!(facts["devices"], json!("8086:a7a0 *8086:56a5"));
    assert_eq!(facts["webgl"], json!("enabled"));
    assert_eq!(facts["rasterization"], json!("disabled_software"));
}

#[test]
fn reports_empty_fields_when_chromium_has_no_gpu_information() {
    let facts = gpu_facts(&GpuFeatureStatus::default(), &GpuInfo::default());
    assert_eq!(facts["glRenderer"], json!(""));
    assert_eq!(facts["devices"], json!(""));
    assert_eq!(facts["webgl"], json!(""));
}

#[test]
fn writes_a_question_mark_for_a_device_without_ids() {
    let facts = gpu_facts(
        &GpuFeatureStatus::default(),
        &GpuInfo {
            gpu_device: vec![GpuDevice::default()],
            ..GpuInfo::default()
        },
    );
    assert_eq!(facts["devices"], json!("?:?"));
}

#[tokio::test]
async fn reports_on_the_first_update_only() {
    let (report, log) = registered(Ok(GpuInfo::default()));
    report.gpu_info_updated().await;
    report.gpu_info_updated().await;
    assert_eq!(log.at("info").len(), 1);
}

#[tokio::test]
async fn reports_again_after_the_gpu_process_is_gone_and_ignores_other_processes() {
    let (report, log) = registered(Ok(GpuInfo::default()));
    report.child_process_gone("Utility").await;
    report.child_process_gone("Tab").await;
    assert!(log.at("info").is_empty());
    report.child_process_gone("GPU").await;
    let logged = log.at("info");
    assert_eq!(logged.len(), 1);
    assert_eq!(logged[0].0, "gpu-info-after-gone");
}

#[tokio::test]
async fn warns_with_the_error_text_when_the_gpu_information_cannot_be_read() {
    let (report, log) = registered(Err("gpu process is gone".to_owned()));
    report.gpu_info_updated().await;
    assert!(log.at("info").is_empty());
    let warned = log.at("warn");
    assert_eq!(warned.len(), 1);
    assert_eq!(warned[0].0, "gpu-info");
    assert_eq!(
        warned[0].1.to_json(),
        json!({"error": "gpu process is gone"})
    );
}
