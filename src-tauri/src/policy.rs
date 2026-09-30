use epikrise_llm::{ProviderAdapter, ProviderProfile};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::{
    fs, io,
    net::IpAddr,
    path::{Path, PathBuf},
};
use thiserror::Error;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct EgressPolicy {
    #[serde(default)]
    pub allowed_providers: Option<Vec<ProviderAdapter>>,
    #[serde(default)]
    pub local_only: bool,
    #[serde(default = "allow_by_default")]
    pub allow_url_ingestion: bool,
    #[serde(default = "allow_by_default")]
    pub allow_updater: bool,
    #[serde(default = "require_review")]
    pub require_review_gate: bool,
}

impl Default for EgressPolicy {
    fn default() -> Self {
        Self {
            allowed_providers: None,
            local_only: false,
            allow_url_ingestion: true,
            allow_updater: true,
            require_review_gate: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PolicyStatus {
    pub active: bool,
    pub local_only: bool,
    pub allowed_providers: Option<Vec<ProviderAdapter>>,
    pub allow_url_ingestion: bool,
    pub allow_updater: bool,
    pub require_review_gate: bool,
    pub permissions_warning: bool,
}

#[derive(Debug, Error)]
pub enum PolicyLoadError {
    #[error("policy path could not be determined")]
    PathUnavailable,
    #[error("policy file could not be inspected")]
    InspectFailed(#[source] io::Error),
    #[error("policy file must be a regular, non-symlink file")]
    UnsafeFile,
    #[error("policy file is malformed")]
    Malformed(#[source] toml::de::Error),
}

pub struct LoadedPolicy {
    pub policy: EgressPolicy,
    pub status: PolicyStatus,
}

pub struct PolicyState(pub LoadedPolicy);

impl LoadedPolicy {
    pub fn load() -> Result<Self, PolicyLoadError> {
        let Some(path) = policy_path() else {
            return Err(PolicyLoadError::PathUnavailable);
        };
        Self::load_from(&path)
    }

    fn load_from(path: &Path) -> Result<Self, PolicyLoadError> {
        let metadata = match fs::symlink_metadata(path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(Self::from_policy(EgressPolicy::default(), false, false));
            }
            Err(error) => return Err(PolicyLoadError::InspectFailed(error)),
        };
        if !metadata.file_type().is_file() {
            return Err(PolicyLoadError::UnsafeFile);
        }
        let permissions_warning = !administrator_controls_file(path, &metadata);
        let contents = fs::read_to_string(path).map_err(PolicyLoadError::InspectFailed)?;
        let policy = toml::from_str(&contents).map_err(PolicyLoadError::Malformed)?;
        Ok(Self::from_policy(policy, true, permissions_warning))
    }

    fn from_policy(policy: EgressPolicy, active: bool, permissions_warning: bool) -> Self {
        let status = PolicyStatus {
            active,
            local_only: policy.local_only,
            allowed_providers: policy.allowed_providers.clone(),
            allow_url_ingestion: policy.allow_url_ingestion,
            allow_updater: policy.allow_updater,
            require_review_gate: true,
            permissions_warning,
        };
        Self { policy, status }
    }

    pub fn allows_provider(&self, profile: &ProviderProfile) -> bool {
        if self
            .policy
            .allowed_providers
            .as_ref()
            .is_some_and(|allowed| !allowed.contains(&profile.adapter))
        {
            return false;
        }
        !self.policy.local_only || is_local_endpoint(profile)
    }

    pub fn requires_egress_confirmation(&self, profile: &ProviderProfile) -> bool {
        !is_local_endpoint(profile)
    }

    pub fn allows_url_ingestion(&self) -> bool {
        self.policy.allow_url_ingestion
    }
}

pub fn egress_key(case_id: &str, profile: &ProviderProfile) -> String {
    let adapter = match profile.adapter {
        ProviderAdapter::OpenAi => "open_ai",
        ProviderAdapter::Anthropic => "anthropic",
        ProviderAdapter::Gemini => "gemini",
        ProviderAdapter::Ollama => "ollama",
        ProviderAdapter::OpenAiCompatible => "open_ai_compatible",
        ProviderAdapter::OpenRouter => "open_router",
        ProviderAdapter::Xai => "xai",
        ProviderAdapter::Groq => "groq",
    };
    let endpoint = profile.endpoint.as_deref().unwrap_or_default();
    format!("{case_id}:{adapter}:{endpoint}")
}

fn allow_by_default() -> bool {
    true
}

fn require_review() -> bool {
    true
}

#[cfg(target_os = "linux")]
fn policy_path() -> Option<PathBuf> {
    Some(PathBuf::from("/etc/epikrise/policy.toml"))
}

#[cfg(target_os = "macos")]
fn policy_path() -> Option<PathBuf> {
    Some(PathBuf::from(
        "/Library/Application Support/Epikrise/policy.toml",
    ))
}

#[cfg(target_os = "windows")]
fn policy_path() -> Option<PathBuf> {
    std::env::var_os("ProgramData").map(|root| PathBuf::from(root).join("Epikrise/policy.toml"))
}

#[cfg(unix)]
fn administrator_controls_file(path: &Path, metadata: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;

    let Some(parent) = path.parent() else {
        return false;
    };
    let Ok(parent_metadata) = fs::symlink_metadata(parent) else {
        return false;
    };
    metadata.uid() == 0
        && parent_metadata.uid() == 0
        && metadata.mode() & 0o022 == 0
        && parent_metadata.mode() & 0o022 == 0
        && parent_metadata.file_type().is_dir()
}

#[cfg(windows)]
fn administrator_controls_file(path: &Path, _metadata: &fs::Metadata) -> bool {
    use std::process::Command;

    let Some(system_root) = std::env::var_os("SystemRoot") else {
        return false;
    };
    let powershell =
        PathBuf::from(system_root).join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let Some(parent) = path.parent() else {
        return false;
    };
    const ACL_CHECK: &str = r#"
$trusted = @('S-1-5-18', 'S-1-5-32-544')
$write = [System.Security.AccessControl.FileSystemRights]::WriteData -bor
  [System.Security.AccessControl.FileSystemRights]::AppendData -bor
  [System.Security.AccessControl.FileSystemRights]::WriteAttributes -bor
  [System.Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
  [System.Security.AccessControl.FileSystemRights]::Delete -bor
  [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor
  [System.Security.AccessControl.FileSystemRights]::TakeOwnership -bor
  [System.Security.AccessControl.FileSystemRights]::Modify -bor
  [System.Security.AccessControl.FileSystemRights]::FullControl
foreach ($target in $args) {
  $acl = Get-Acl -LiteralPath $target -ErrorAction Stop
  if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -notin $trusted) { exit 1 }
  foreach ($rule in $acl.Access) {
    $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
    if ($rule.AccessControlType -eq 'Allow' -and ($rule.FileSystemRights -band $write) -ne 0 -and $sid -notin $trusted) { exit 1 }
  }
}
Write-Output 'safe'
"#;
    let output = Command::new(powershell)
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            ACL_CHECK,
        ])
        .arg(path)
        .arg(parent)
        .output();
    output.is_ok_and(|output| output.status.success() && output.stdout.starts_with(b"safe"))
}

#[cfg(not(any(unix, windows)))]
fn administrator_controls_file(_path: &Path, _metadata: &fs::Metadata) -> bool {
    false
}

fn is_local_endpoint(profile: &ProviderProfile) -> bool {
    let endpoint = profile.endpoint.as_deref().or_else(|| {
        (profile.adapter == ProviderAdapter::Ollama).then_some("http://localhost:11434")
    });
    let Some(endpoint) = endpoint.and_then(|endpoint| url::Url::parse(endpoint).ok()) else {
        return false;
    };
    let Some(host) = endpoint.host_str() else {
        return false;
    };
    host.eq_ignore_ascii_case("localhost")
        || host
            .trim_start_matches('[')
            .trim_end_matches(']')
            .parse::<IpAddr>()
            .is_ok_and(|address| address.is_loopback())
}

#[cfg(test)]
mod tests {
    use super::LoadedPolicy;
    use epikrise_llm::{
        AuthSource, GenerationParams, ModelCapabilities, ProviderAdapter, ProviderProfile,
    };
    use std::{fs, path::Path};

    fn profile(adapter: ProviderAdapter, endpoint: Option<&str>) -> ProviderProfile {
        ProviderProfile {
            id: "test".to_owned(),
            display_name: "Test".to_owned(),
            adapter,
            model: "test-model".to_owned(),
            endpoint: endpoint.map(str::to_owned),
            auth: AuthSource::None,
            capabilities: ModelCapabilities {
                vision: false,
                streaming: true,
                max_context: None,
            },
            generation: GenerationParams {
                temperature: None,
                max_tokens: None,
                reasoning_effort: None,
            },
        }
    }

    fn load_policy(directory: &Path, contents: &str) -> LoadedPolicy {
        let path = directory.join("policy.toml");
        fs::write(&path, contents).expect("test policy should be written");
        LoadedPolicy::load_from(&path).expect("test policy should load")
    }

    #[test]
    fn local_only_rejects_cloud_profiles_even_when_adapter_is_allowlisted() {
        let directory = tempfile::tempdir().expect("temporary directory should be created");
        let policy = load_policy(
            directory.path(),
            "allowed_providers = ['open_ai']\nlocal_only = true\n",
        );
        assert!(!policy.allows_provider(&profile(
            ProviderAdapter::OpenAi,
            Some("https://api.openai.com/v1"),
        )));
    }

    #[test]
    fn local_only_accepts_loopback_ollama_and_local_compatible_endpoints() {
        let directory = tempfile::tempdir().expect("temporary directory should be created");
        let policy = load_policy(directory.path(), "local_only = true\n");
        assert!(policy.allows_provider(&profile(ProviderAdapter::Ollama, None)));
        assert!(policy.allows_provider(&profile(
            ProviderAdapter::OpenAiCompatible,
            Some("http://127.0.0.1:8080/v1"),
        )));
        assert!(policy.allows_provider(&profile(
            ProviderAdapter::OpenAiCompatible,
            Some("http://[::1]:8080/v1"),
        )));
        assert!(!policy.allows_provider(&profile(
            ProviderAdapter::Ollama,
            Some("https://remote.example/v1"),
        )));
    }

    #[test]
    fn malformed_and_symlink_policy_files_are_rejected() {
        let directory = tempfile::tempdir().expect("temporary directory should be created");
        let malformed = directory.path().join("malformed.toml");
        fs::write(&malformed, "local_only = [").expect("test policy should be written");
        assert!(LoadedPolicy::load_from(&malformed).is_err());

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let link = directory.path().join("linked.toml");
            symlink(&malformed, &link).expect("test symlink should be created");
            assert!(LoadedPolicy::load_from(&link).is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn warns_when_policy_directory_is_writable_by_non_admins() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().expect("temporary directory should be created");
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o777))
            .expect("test policy directory permissions should be changed");
        let policy = load_policy(directory.path(), "local_only = true\n");

        assert!(policy.status.permissions_warning);
    }

    #[test]
    fn review_gate_cannot_be_disabled_by_policy() {
        let directory = tempfile::tempdir().expect("temporary directory should be created");
        let policy = load_policy(directory.path(), "require_review_gate = false\n");
        assert!(policy.status.require_review_gate);
    }

    #[test]
    fn provider_allowlist_and_url_ingestion_are_restriction_only() {
        let directory = tempfile::tempdir().expect("temporary directory should be created");
        let policy = load_policy(
            directory.path(),
            "allowed_providers = ['ollama']\nallow_url_ingestion = false\n",
        );

        assert!(policy.allows_provider(&profile(ProviderAdapter::Ollama, None)));
        assert!(!policy.allows_provider(&profile(
            ProviderAdapter::OpenAi,
            Some("https://api.openai.com/v1"),
        )));
        assert!(!policy.allows_url_ingestion());
    }

    #[test]
    fn remote_confirmation_is_endpoint_and_case_scoped() {
        use super::{EgressPolicy, egress_key};

        let policy = LoadedPolicy::from_policy(EgressPolicy::default(), false, false);
        let remote = profile(ProviderAdapter::OpenAi, Some("https://api.openai.com/v1"));
        assert!(policy.requires_egress_confirmation(&remote));
        assert!(!policy.requires_egress_confirmation(&profile(ProviderAdapter::Ollama, None,)));
        assert_ne!(egress_key("case-a", &remote), egress_key("case-b", &remote));
        assert_ne!(
            egress_key("case-a", &remote),
            egress_key(
                "case-a",
                &profile(ProviderAdapter::OpenAi, Some("https://other.example/v1")),
            ),
        );
    }
}
