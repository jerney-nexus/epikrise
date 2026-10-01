use epikrise_llm::{ProviderAdapter, ProviderProfile, ReasoningEffort};
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
    #[serde(default = "allow_by_default")]
    pub allow_template_import: bool,
    #[serde(default = "allow_by_default")]
    pub allow_template_export: bool,
    #[serde(default = "allow_by_default")]
    pub allow_template_edit: bool,
    #[serde(default)]
    pub allowed_models: Option<Vec<AllowedModel>>,
    #[serde(default)]
    pub max_output_tokens: Option<u32>,
    #[serde(default)]
    pub max_reasoning_effort: Option<ReasoningEffort>,
    #[serde(default)]
    pub fixed_endpoint: Option<String>,
    #[serde(default = "allow_by_default")]
    pub allow_credential_management: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Type)]
#[serde(deny_unknown_fields)]
pub struct AllowedModel {
    pub adapter: ProviderAdapter,
    pub model: String,
}

impl Default for EgressPolicy {
    fn default() -> Self {
        Self {
            allowed_providers: None,
            local_only: false,
            allow_url_ingestion: true,
            allow_updater: true,
            require_review_gate: true,
            allow_template_import: true,
            allow_template_export: true,
            allow_template_edit: true,
            allowed_models: None,
            max_output_tokens: None,
            max_reasoning_effort: None,
            fixed_endpoint: None,
            allow_credential_management: true,
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
    pub allow_template_import: bool,
    pub allow_template_export: bool,
    pub allow_template_edit: bool,
    pub allowed_models: Option<Vec<AllowedModel>>,
    pub max_output_tokens: Option<u32>,
    pub max_reasoning_effort: Option<ReasoningEffort>,
    pub fixed_endpoint: Option<String>,
    pub allow_credential_management: bool,
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
    #[error("policy contains an invalid restriction")]
    InvalidPolicy,
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
        let mut policy: EgressPolicy =
            toml::from_str(&contents).map_err(PolicyLoadError::Malformed)?;
        if policy.max_output_tokens == Some(0)
            || policy
                .allowed_models
                .as_ref()
                .is_some_and(|models| models.iter().any(|model| model.model.trim().is_empty()))
        {
            return Err(PolicyLoadError::InvalidPolicy);
        }
        if let Some(endpoint) = policy.fixed_endpoint.as_deref() {
            let parsed = url::Url::parse(endpoint).map_err(|_| PolicyLoadError::InvalidPolicy)?;
            if !matches!(parsed.scheme(), "http" | "https")
                || parsed.host_str().is_none()
                || !parsed.username().is_empty()
                || parsed.password().is_some()
            {
                return Err(PolicyLoadError::InvalidPolicy);
            }
            policy.fixed_endpoint = Some(parsed.to_string());
        }
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
            allow_template_import: policy.allow_template_import,
            allow_template_export: policy.allow_template_export,
            allow_template_edit: policy.allow_template_edit,
            allowed_models: policy.allowed_models.clone(),
            max_output_tokens: policy.max_output_tokens,
            max_reasoning_effort: policy.max_reasoning_effort,
            fixed_endpoint: policy.fixed_endpoint.clone(),
            allow_credential_management: policy.allow_credential_management,
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

    pub fn allows_model(&self, profile: &ProviderProfile) -> bool {
        self.policy.allowed_models.as_ref().is_none_or(|models| {
            models
                .iter()
                .any(|allowed| allowed.adapter == profile.adapter && allowed.model == profile.model)
        })
    }

    pub fn filter_models(&self, adapter: &ProviderAdapter, models: Vec<String>) -> Vec<String> {
        self.policy
            .allowed_models
            .as_ref()
            .map_or(models.clone(), |allowed| {
                models
                    .into_iter()
                    .filter(|model| {
                        allowed
                            .iter()
                            .any(|entry| entry.adapter == *adapter && entry.model == *model)
                    })
                    .collect()
            })
    }

    pub fn apply_generation_limits(&self, profile: &mut ProviderProfile) {
        if let Some(max_tokens) = self.policy.max_output_tokens {
            profile.generation.max_tokens = Some(
                profile
                    .generation
                    .max_tokens
                    .map_or(max_tokens, |tokens| tokens.min(max_tokens)),
            );
        }
        if let Some(max_effort) = self.policy.max_reasoning_effort {
            let requested = profile.generation.reasoning_effort.as_ref();
            let capped = requested
                .filter(|requested| reasoning_rank(requested) <= reasoning_rank(&max_effort))
                .cloned()
                .unwrap_or(max_effort);
            profile.generation.reasoning_effort = Some(capped);
        }
    }

    pub fn apply_fixed_endpoint(&self, profile: &mut ProviderProfile) {
        if let Some(endpoint) = &self.policy.fixed_endpoint {
            profile.endpoint = Some(endpoint.clone());
        }
    }

    pub fn allows_credential_management(&self) -> bool {
        self.policy.allow_credential_management
    }

    pub fn requires_egress_confirmation(&self, profile: &ProviderProfile) -> bool {
        !is_local_endpoint(profile)
    }

    pub fn allows_url_ingestion(&self) -> bool {
        self.policy.allow_url_ingestion
    }
}

fn reasoning_rank(effort: &ReasoningEffort) -> u8 {
    match effort {
        ReasoningEffort::None => 0,
        ReasoningEffort::Minimal => 1,
        ReasoningEffort::Low => 2,
        ReasoningEffort::Medium => 3,
        ReasoningEffort::High => 4,
        ReasoningEffort::XHigh => 5,
        ReasoningEffort::Max => 6,
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
    fn model_allowlist_and_generation_limits_are_enforced() {
        use epikrise_llm::ReasoningEffort;

        let directory = tempfile::tempdir().expect("temporary directory should be created");
        let policy = load_policy(
            directory.path(),
            "allowed_models = [{ adapter = 'ollama', model = 'approved-model' }]\nmax_output_tokens = 2048\nmax_reasoning_effort = 'medium'\n",
        );
        let mut allowed = profile(ProviderAdapter::Ollama, None);
        allowed.model = "approved-model".to_owned();
        allowed.generation.max_tokens = Some(8192);
        allowed.generation.reasoning_effort = Some(ReasoningEffort::Max);

        assert!(policy.allows_model(&allowed));
        assert!(!policy.allows_model(&profile(ProviderAdapter::Ollama, None)));
        assert_eq!(
            policy.filter_models(
                &ProviderAdapter::Ollama,
                vec!["approved-model".to_owned(), "blocked-model".to_owned()],
            ),
            vec!["approved-model"]
        );

        policy.apply_generation_limits(&mut allowed);
        assert_eq!(allowed.generation.max_tokens, Some(2048));
        assert_eq!(
            allowed.generation.reasoning_effort,
            Some(ReasoningEffort::Medium)
        );

        allowed.generation.max_tokens = None;
        allowed.generation.reasoning_effort = None;
        policy.apply_generation_limits(&mut allowed);
        assert_eq!(allowed.generation.max_tokens, Some(2048));
        assert_eq!(
            allowed.generation.reasoning_effort,
            Some(ReasoningEffort::Medium)
        );
    }

    #[test]
    fn policy_rejects_zero_output_token_ceiling() {
        let directory = tempfile::tempdir().expect("temporary directory should be created");
        let path = directory.path().join("policy.toml");
        fs::write(&path, "max_output_tokens = 0\n").expect("test policy should be written");
        assert!(LoadedPolicy::load_from(&path).is_err());
    }

    #[test]
    fn fixed_endpoint_overrides_provider_profiles_and_can_disable_credentials() {
        let directory = tempfile::tempdir().expect("temporary directory should be created");
        let policy = load_policy(
            directory.path(),
            "fixed_endpoint = 'https://gateway.example/v1'\nallow_credential_management = false\n",
        );
        let mut configured = profile(
            ProviderAdapter::OpenAiCompatible,
            Some("https://user.example/v1"),
        );

        policy.apply_fixed_endpoint(&mut configured);

        assert_eq!(
            configured.endpoint.as_deref(),
            Some("https://gateway.example/v1")
        );
        assert!(!policy.allows_credential_management());
        assert_eq!(
            policy.status.fixed_endpoint.as_deref(),
            Some("https://gateway.example/v1")
        );
        assert!(!policy.status.allow_credential_management);
    }

    #[test]
    fn fixed_endpoint_rejects_invalid_schemes_and_inline_credentials() {
        let directory = tempfile::tempdir().expect("temporary directory should be created");
        for (index, endpoint) in [
            "file:///etc/passwd",
            "https://user:secret@gateway.example/v1",
        ]
        .into_iter()
        .enumerate()
        {
            let path = directory.path().join(format!("policy-{index}.toml"));
            fs::write(&path, format!("fixed_endpoint = '{endpoint}'\n"))
                .expect("test policy should be written");
            assert!(LoadedPolicy::load_from(&path).is_err());
        }
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
