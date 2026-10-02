use serde::{Deserialize, Serialize};
use specta::Type;
use std::{
    fs,
    io::Write,
    path::PathBuf,
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicBool, Ordering},
    },
};
use tauri::{AppHandle, Manager, State};
use tauri_specta::Event;
use thiserror::Error;
#[cfg(feature = "direct-release-updater")]
use url::Url;

use crate::policy::PolicyState;
use crate::{CaseSessionRegistry, GenerationRegistry};

#[cfg(feature = "direct-release-updater")]
const UPDATE_ENDPOINT: &str =
    "https://github.com/jerney-nexus/epikrise/releases/latest/download/latest.json";
#[cfg(feature = "direct-release-updater")]
const APPROVED_UPDATE_HOSTS: [&str; 3] = [
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
];

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSettings {
    pub available: bool,
    pub enabled: bool,
    pub policy_allowed: bool,
}

#[derive(Debug, Error, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum UpdaterError {
    #[error("updates are unavailable for this build")]
    Unavailable,
    #[error("updates are disabled by administrator policy")]
    PolicyDenied,
    #[error("enable updates before checking for updates")]
    OptInRequired,
    #[error("update settings could not be saved")]
    SettingsFailed,
    #[error("an update operation is already in progress")]
    Busy,
    #[error("an update cannot be installed while a case or generation is active")]
    ActiveWork,
    #[error("the update could not be verified or installed")]
    UpdateFailed,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredSettings {
    #[serde(default)]
    enabled: bool,
}

#[derive(Default)]
pub struct UpdaterState {
    settings: Mutex<StoredSettings>,
    #[cfg(feature = "direct-release-updater")]
    candidate: Mutex<Option<tauri_plugin_updater::Update>>,
}

#[derive(Default, Clone)]
pub struct UpdateInstallGate(Arc<AtomicBool>);

pub struct UpdateInstallPermit(Arc<AtomicBool>);

impl Drop for UpdateInstallPermit {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

impl UpdateInstallGate {
    pub fn try_enter(&self) -> Result<UpdateInstallPermit, UpdaterError> {
        self.0
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .map(|_| UpdateInstallPermit(Arc::clone(&self.0)))
            .map_err(|_| UpdaterError::Busy)
    }
}

impl UpdaterState {
    pub fn load(app: &AppHandle) -> Self {
        let settings = settings_path(app)
            .ok()
            .and_then(|path| fs::read_to_string(path).ok())
            .and_then(|content| serde_json::from_str(&content).ok())
            .unwrap_or_default();
        Self {
            settings: Mutex::new(settings),
            #[cfg(feature = "direct-release-updater")]
            candidate: Mutex::new(None),
        }
    }

    fn lock(&self) -> Result<MutexGuard<'_, StoredSettings>, UpdaterError> {
        self.settings
            .lock()
            .map_err(|_| UpdaterError::SettingsFailed)
    }
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCandidate {
    pub version: String,
    pub notes: Option<String>,
    pub target: String,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    pub downloaded_bytes: f64,
    pub total_bytes: Option<f64>,
    pub finished: bool,
}

impl Event for UpdateProgress {
    const NAME: &'static str = "updater://progress";
}

pub fn authorize(available: bool, enabled: bool, policy_allowed: bool) -> Result<(), UpdaterError> {
    if !available {
        return Err(UpdaterError::Unavailable);
    }
    if !policy_allowed {
        return Err(UpdaterError::PolicyDenied);
    }
    if !enabled {
        return Err(UpdaterError::OptInRequired);
    }
    Ok(())
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, UpdaterError> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join("updater.json"))
        .map_err(|_| UpdaterError::SettingsFailed)
}

fn persist_settings(path: &PathBuf, settings: &StoredSettings) -> Result<(), UpdaterError> {
    let parent = path.parent().ok_or(UpdaterError::SettingsFailed)?;
    fs::create_dir_all(parent).map_err(|_| UpdaterError::SettingsFailed)?;
    let mut temporary =
        tempfile::NamedTempFile::new_in(parent).map_err(|_| UpdaterError::SettingsFailed)?;
    serde_json::to_writer(&mut temporary, settings).map_err(|_| UpdaterError::SettingsFailed)?;
    temporary
        .write_all(b"\n")
        .map_err(|_| UpdaterError::SettingsFailed)?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|_| UpdaterError::SettingsFailed)?;
    temporary
        .persist(path)
        .map_err(|_| UpdaterError::SettingsFailed)?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn get_update_settings(
    policy: State<'_, PolicyState>,
    updater: State<'_, UpdaterState>,
) -> Result<UpdateSettings, UpdaterError> {
    let policy_allowed = policy.0.policy.allow_updater;
    Ok(UpdateSettings {
        available: cfg!(feature = "direct-release-updater"),
        enabled: updater.lock()?.enabled,
        policy_allowed,
    })
}

#[tauri::command]
#[specta::specta]
pub fn set_update_enabled(
    app: AppHandle,
    enabled: bool,
    policy: State<'_, PolicyState>,
    updater: State<'_, UpdaterState>,
) -> Result<UpdateSettings, UpdaterError> {
    let policy_allowed = policy.0.policy.allow_updater;
    if enabled {
        authorize(
            cfg!(feature = "direct-release-updater"),
            true,
            policy_allowed,
        )?;
    }

    let path = settings_path(&app)?;
    let mut settings = updater.lock()?;
    let updated = StoredSettings { enabled };
    persist_settings(&path, &updated)?;
    *settings = updated;

    Ok(UpdateSettings {
        available: cfg!(feature = "direct-release-updater"),
        enabled,
        policy_allowed,
    })
}

#[cfg(feature = "direct-release-updater")]
fn approved_https_url(url: &Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none_or(|port| port == 443)
        && url
            .host_str()
            .is_some_and(|host| APPROVED_UPDATE_HOSTS.contains(&host))
}

#[cfg(feature = "direct-release-updater")]
fn release_version_from_protocol(version: &str) -> Result<String, UpdaterError> {
    let mut parts = version.split('.');
    let year = parts.next().ok_or(UpdaterError::UpdateFailed)?;
    let month = parts.next().ok_or(UpdaterError::UpdateFailed)?;
    let patch = parts.next().ok_or(UpdaterError::UpdateFailed)?;
    if parts.next().is_some()
        || year.len() != 4
        || !year.bytes().all(|byte| byte.is_ascii_digit())
        || month.len() > 1 && month.starts_with('0')
        || !month.bytes().all(|byte| byte.is_ascii_digit())
        || patch.len() > 1 && patch.starts_with('0')
        || !patch.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(UpdaterError::UpdateFailed);
    }
    let year = year
        .parse::<u16>()
        .map_err(|_| UpdaterError::UpdateFailed)?;
    let month = month
        .parse::<u8>()
        .map_err(|_| UpdaterError::UpdateFailed)?;
    let patch = patch
        .parse::<u32>()
        .map_err(|_| UpdaterError::UpdateFailed)?;
    if !(2000..=2255).contains(&year) || !(1..=12).contains(&month) || patch > 65535 {
        return Err(UpdaterError::UpdateFailed);
    }
    Ok(format!("{year}.{month:02}.{patch}"))
}

#[cfg(feature = "direct-release-updater")]
fn release_target() -> Result<&'static str, UpdaterError> {
    if cfg!(target_os = "windows") {
        if cfg!(feature = "updater-windows-x86_64-nsis") {
            return Ok("windows-x86_64-nsis");
        }
        if cfg!(feature = "updater-windows-aarch64-nsis") {
            return Ok("windows-aarch64-nsis");
        }
        if cfg!(feature = "updater-windows-x86_64-msi") {
            return Ok("windows-x86_64-msi");
        }
        if cfg!(feature = "updater-windows-aarch64-msi") {
            return Ok("windows-aarch64-msi");
        }
        return Err(UpdaterError::Unavailable);
    }
    if cfg!(target_os = "macos") {
        return match std::env::consts::ARCH {
            "x86_64" => Ok("darwin-x86_64"),
            "aarch64" => Ok("darwin-aarch64"),
            _ => Err(UpdaterError::Unavailable),
        };
    }
    if cfg!(target_os = "linux") {
        return match std::env::consts::ARCH {
            "x86_64" => Ok("linux-x86_64"),
            "aarch64" => Ok("linux-aarch64"),
            _ => Err(UpdaterError::Unavailable),
        };
    }
    Err(UpdaterError::Unavailable)
}

#[cfg(feature = "direct-release-updater")]
fn validate_candidate(
    version: &str,
    target: &str,
    download_url: &Url,
    expected_target: &str,
) -> Result<String, UpdaterError> {
    let release_version = release_version_from_protocol(version)?;
    if target != expected_target || !approved_https_url(download_url) {
        return Err(UpdaterError::UpdateFailed);
    }
    let current = release_version_from_protocol(env!("CARGO_PKG_VERSION"))?;
    let parse_parts = |version: &str| {
        version
            .split('.')
            .map(|part| part.parse::<u32>().map_err(|_| UpdaterError::UpdateFailed))
            .collect::<Result<Vec<_>, _>>()
    };
    if parse_parts(&release_version)? <= parse_parts(&current)? {
        return Err(UpdaterError::UpdateFailed);
    }
    Ok(release_version)
}

fn authorize_current(updater: &UpdaterState, policy: &PolicyState) -> Result<(), UpdaterError> {
    let enabled = updater.lock()?.enabled;
    authorize(
        cfg!(feature = "direct-release-updater"),
        enabled,
        policy.0.policy.allow_updater,
    )
}

#[tauri::command]
#[specta::specta]
pub async fn check_for_update(
    app: AppHandle,
    policy: State<'_, PolicyState>,
    updater_state: State<'_, UpdaterState>,
) -> Result<Option<UpdateCandidate>, UpdaterError> {
    authorize_current(&updater_state, &policy)?;
    #[cfg(feature = "direct-release-updater")]
    {
        use tauri_plugin_updater::UpdaterExt;

        let target = release_target()?;
        let endpoint = Url::parse(UPDATE_ENDPOINT).map_err(|_| UpdaterError::UpdateFailed)?;
        let updater = app
            .updater_builder()
            .target(target)
            .endpoints(vec![endpoint])
            .map_err(|_| UpdaterError::UpdateFailed)?
            .timeout(std::time::Duration::from_secs(30))
            .configure_client(|client| {
                client.redirect(reqwest_updater::redirect::Policy::custom(|attempt| {
                    let approved_chain = approved_https_url(attempt.url())
                        && attempt.previous().iter().all(approved_https_url);
                    if approved_chain {
                        attempt.follow()
                    } else {
                        attempt.stop()
                    }
                }))
            })
            .build()
            .map_err(|_| UpdaterError::UpdateFailed)?;
        let Some(candidate) = updater
            .check()
            .await
            .map_err(|_| UpdaterError::UpdateFailed)?
        else {
            *updater_state
                .candidate
                .lock()
                .map_err(|_| UpdaterError::UpdateFailed)? = None;
            return Ok(None);
        };
        let version = validate_candidate(
            &candidate.version,
            &candidate.target,
            &candidate.download_url,
            target,
        )?;
        if candidate.signature.trim().is_empty() {
            return Err(UpdaterError::UpdateFailed);
        }
        let result = UpdateCandidate {
            version,
            notes: candidate.body.clone(),
            target: candidate.target.clone(),
        };
        *updater_state
            .candidate
            .lock()
            .map_err(|_| UpdaterError::UpdateFailed)? = Some(candidate);
        Ok(Some(result))
    }
    #[cfg(not(feature = "direct-release-updater"))]
    {
        let _ = app;
        Err(UpdaterError::Unavailable)
    }
}

#[tauri::command]
#[specta::specta]
pub async fn install_update(
    app: AppHandle,
    confirmed: bool,
    policy: State<'_, PolicyState>,
    updater_state: State<'_, UpdaterState>,
    install_gate: State<'_, UpdateInstallGate>,
    sessions: State<'_, CaseSessionRegistry>,
    generations: State<'_, GenerationRegistry>,
) -> Result<(), UpdaterError> {
    authorize_current(&updater_state, &policy)?;
    if !confirmed {
        return Err(UpdaterError::OptInRequired);
    }
    let _permit = install_gate.try_enter()?;
    if sessions
        .0
        .lock()
        .map_err(|_| UpdaterError::UpdateFailed)?
        .is_some()
        || !generations
            .0
            .lock()
            .map_err(|_| UpdaterError::UpdateFailed)?
            .is_empty()
    {
        return Err(UpdaterError::ActiveWork);
    }

    #[cfg(feature = "direct-release-updater")]
    {
        let candidate = updater_state
            .candidate
            .lock()
            .map_err(|_| UpdaterError::UpdateFailed)?
            .clone()
            .ok_or(UpdaterError::UpdateFailed)?;
        validate_candidate(
            &candidate.version,
            &candidate.target,
            &candidate.download_url,
            release_target()?,
        )?;
        authorize_current(&updater_state, &policy)?;
        let app_for_progress = app.clone();
        let downloaded = std::sync::atomic::AtomicU64::new(0);
        candidate
            .download_and_install(
                |chunk_length, content_length| {
                    let downloaded_bytes = downloaded
                        .fetch_add(chunk_length as u64, Ordering::Relaxed)
                        .saturating_add(chunk_length as u64);
                    let _ = UpdateProgress {
                        downloaded_bytes: downloaded_bytes as f64,
                        total_bytes: content_length.map(|length| length as f64),
                        finished: false,
                    }
                    .emit(&app_for_progress);
                },
                || {},
            )
            .await
            .map_err(|_| UpdaterError::UpdateFailed)?;
        *updater_state
            .candidate
            .lock()
            .map_err(|_| UpdaterError::UpdateFailed)? = None;
        let _ = UpdateProgress {
            downloaded_bytes: downloaded.load(Ordering::Relaxed) as f64,
            total_bytes: None,
            finished: true,
        }
        .emit(&app);
        Ok(())
    }
    #[cfg(not(feature = "direct-release-updater"))]
    {
        let _ = app;
        Err(UpdaterError::Unavailable)
    }
}

#[cfg(test)]
mod tests {
    use super::{UpdateInstallGate, UpdaterError, authorize};
    #[cfg(feature = "direct-release-updater")]
    use super::{approved_https_url, release_version_from_protocol, validate_candidate};
    #[cfg(feature = "direct-release-updater")]
    use url::Url;

    #[test]
    fn denied_update_actions_do_not_call_the_service() {
        for (available, enabled, policy_allowed, expected_error) in [
            (false, true, true, UpdaterError::Unavailable),
            (true, false, true, UpdaterError::OptInRequired),
            (true, true, false, UpdaterError::PolicyDenied),
        ] {
            let mut service_calls = 0;
            let result = authorize(available, enabled, policy_allowed).map(|()| {
                service_calls += 1;
            });
            assert_eq!(result, Err(expected_error));
            assert_eq!(service_calls, 0);
        }
    }

    #[test]
    fn update_actions_require_a_available_opted_in_policy_state() {
        assert_eq!(authorize(true, true, true), Ok(()));
    }

    #[test]
    fn install_permit_excludes_new_work_until_released() {
        let gate = UpdateInstallGate::default();
        let permit = gate.try_enter();
        assert!(permit.is_ok());
        assert_eq!(gate.try_enter().err(), Some(UpdaterError::Busy));
        drop(permit);
        assert!(gate.try_enter().is_ok());
    }

    #[cfg(feature = "direct-release-updater")]
    #[test]
    fn release_candidate_preserves_calver_and_rejects_downgrades_or_wrong_targets() {
        let url = Url::parse(
            "https://github.com/jerney-nexus/epikrise/releases/download/v2026.11.0/app.AppImage",
        )
        .expect("test URL should parse");
        assert_eq!(
            release_version_from_protocol("2026.9.4").as_deref(),
            Ok("2026.09.4")
        );
        assert!(validate_candidate("2026.11.0", "linux-x86_64", &url, "linux-x86_64").is_ok());
        assert!(validate_candidate("2026.9.4", "linux-x86_64", &url, "linux-x86_64").is_err());
        assert!(validate_candidate("2026.11.0", "linux-aarch64", &url, "linux-x86_64").is_err());
        assert!(release_version_from_protocol("2026.09.4").is_err());
        assert!(release_version_from_protocol("2026.13.0").is_err());
    }

    #[cfg(feature = "direct-release-updater")]
    #[test]
    fn redirect_allowlist_requires_https_and_approved_hosts() {
        assert!(approved_https_url(
            &Url::parse("https://release-assets.githubusercontent.com/asset").expect("URL")
        ));
        assert!(!approved_https_url(
            &Url::parse("http://github.com/asset").expect("URL")
        ));
        assert!(!approved_https_url(
            &Url::parse("https://attacker.invalid/asset").expect("URL")
        ));
    }
}
