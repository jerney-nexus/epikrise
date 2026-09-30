//! Provider profiles and the `LlmClient` abstraction over genai.
//!
//! Deliberately free of any Tauri dependency so it can be unit-tested standalone.

#![forbid(unsafe_code)]

use epikrise_core::{ImageAttachment, Redacted};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::sync::Arc;
use thiserror::Error;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Type)]
#[serde(rename_all = "snake_case")]
pub enum ProviderAdapter {
    OpenAi,
    Anthropic,
    Gemini,
    Ollama,
    OpenAiCompatible,
    OpenRouter,
    Xai,
    Groq,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Type)]
#[serde(rename_all = "camelCase")]
pub struct CredentialSummary {
    pub id: String,
    pub adapter: ProviderAdapter,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Type)]
#[serde(tag = "source", rename_all = "snake_case")]
pub enum AuthSource {
    None,
    Keychain { credential_id: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Type)]
pub struct ModelCapabilities {
    pub vision: bool,
    pub streaming: bool,
    pub max_context: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Type)]
pub struct GenerationParams {
    pub temperature: Option<f32>,
    pub max_tokens: Option<u32>,
    #[serde(default)]
    pub reasoning_effort: Option<ReasoningEffort>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Type)]
#[serde(rename_all = "snake_case")]
pub enum ReasoningEffort {
    None,
    Minimal,
    Low,
    Medium,
    High,
    XHigh,
    Max,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Type)]
pub struct ProviderProfile {
    pub id: String,
    pub display_name: String,
    pub adapter: ProviderAdapter,
    pub model: String,
    pub endpoint: Option<String>,
    pub auth: AuthSource,
    pub capabilities: ModelCapabilities,
    pub generation: GenerationParams,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Type)]
#[serde(rename_all = "snake_case")]
pub enum MessageRole {
    System,
    User,
    Assistant,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq, Type)]
pub struct ChatMessage {
    pub role: MessageRole,
    pub content: String,
    #[serde(default)]
    pub images: Vec<ImageAttachment>,
}

impl std::fmt::Debug for ChatMessage {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ChatMessage")
            .field("role", &self.role)
            .field("content", &Redacted(&self.content))
            .field("images", &Redacted(&self.images))
            .finish()
    }
}

#[derive(Debug, Error, Clone, Serialize, Deserialize, PartialEq, Eq, Type)]
#[serde(tag = "key", rename_all = "snake_case")]
pub enum LlmError {
    #[error("provider profile is invalid")]
    InvalidProfile,
    #[error("chat request is invalid")]
    InvalidRequest,
    #[error("provider authentication failed")]
    Authentication,
    #[error("provider could not be reached")]
    Network,
    #[error("provider rejected the model or request")]
    Model,
    #[error("provider rejected the request with HTTP status {status}")]
    ProviderRejected { status: u16 },
    #[error("provider quota was exceeded")]
    Quota,
    #[error("generation was cancelled")]
    Cancelled,
    #[error("internal generation error")]
    Internal,
}

#[async_trait::async_trait]
pub trait LlmClient: Send + Sync {
    async fn complete(
        &self,
        profile: &ProviderProfile,
        messages: &[ChatMessage],
    ) -> Result<String, LlmError>;

    async fn stream(
        &self,
        profile: &ProviderProfile,
        messages: &[ChatMessage],
        cancellation: tokio_util::sync::CancellationToken,
        on_delta: &mut (dyn FnMut(String) + Send),
    ) -> Result<String, LlmError>;
}

pub trait CredentialStore: Send + Sync {
    fn get(&self, credential_id: &str) -> Result<Option<String>, LlmError>;
}

pub struct KeyringCredentialStore;

const KEYRING_SERVICE: &str = "com.pascaljerney.epikrise";

fn adapter_key(adapter: &ProviderAdapter) -> &'static str {
    match adapter {
        ProviderAdapter::OpenAi => "open_ai",
        ProviderAdapter::Anthropic => "anthropic",
        ProviderAdapter::Gemini => "gemini",
        ProviderAdapter::Ollama => "ollama",
        ProviderAdapter::OpenAiCompatible => "open_ai_compatible",
        ProviderAdapter::OpenRouter => "open_router",
        ProviderAdapter::Xai => "xai",
        ProviderAdapter::Groq => "groq",
    }
}

fn parse_adapter_key(key: &str) -> Option<ProviderAdapter> {
    match key {
        "open_ai" => Some(ProviderAdapter::OpenAi),
        "anthropic" => Some(ProviderAdapter::Anthropic),
        "gemini" => Some(ProviderAdapter::Gemini),
        "ollama" => Some(ProviderAdapter::Ollama),
        "open_ai_compatible" => Some(ProviderAdapter::OpenAiCompatible),
        "open_router" => Some(ProviderAdapter::OpenRouter),
        "xai" => Some(ProviderAdapter::Xai),
        "groq" => Some(ProviderAdapter::Groq),
        _ => None,
    }
}

pub fn credential_account_id(adapter: &ProviderAdapter, label: &str) -> Result<String, LlmError> {
    if label.trim().is_empty() || label.chars().any(char::is_control) {
        return Err(LlmError::InvalidProfile);
    }
    let account_id = format!("{}:{label}", adapter_key(adapter));
    credential_entry(&account_id)?;
    Ok(account_id)
}

pub fn parse_credential_account(account_id: &str) -> Option<CredentialSummary> {
    let (adapter_key, label) = account_id.split_once(':')?;
    let adapter = parse_adapter_key(adapter_key)?;
    if label.trim().is_empty() || credential_entry(account_id).is_err() {
        return None;
    }
    Some(CredentialSummary {
        id: account_id.to_owned(),
        adapter,
        label: label.to_owned(),
    })
}

fn credential_entry(credential_id: &str) -> Result<keyring::Entry, LlmError> {
    if credential_id.trim().is_empty()
        || credential_id.len() > 128
        || credential_id.chars().any(char::is_control)
    {
        return Err(LlmError::InvalidProfile);
    }
    keyring::Entry::new(KEYRING_SERVICE, credential_id).map_err(|_| LlmError::Authentication)
}

impl CredentialStore for KeyringCredentialStore {
    fn get(&self, credential_id: &str) -> Result<Option<String>, LlmError> {
        let entry = credential_entry(credential_id)?;
        match entry.get_password() {
            Ok(password) => Ok(Some(password)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(LlmError::Authentication),
        }
    }
}

impl KeyringCredentialStore {
    pub fn list(&self) -> Result<Vec<CredentialSummary>, LlmError> {
        let search = keyring_search::Search::new().map_err(|_| LlmError::Authentication)?;
        #[cfg(target_os = "windows")]
        let search_result = search.by_target(KEYRING_SERVICE);
        #[cfg(not(target_os = "windows"))]
        let search_result = search.by_service(KEYRING_SERVICE);

        let credentials = match search_result {
            Ok(credentials) => credentials,
            Err(keyring_search::Error::NoResults) => return Ok(Vec::new()),
            Err(_) => return Err(LlmError::Authentication),
        };
        let mut summaries: Vec<CredentialSummary> = credentials
            .values()
            .filter_map(|metadata| {
                #[cfg(target_os = "windows")]
                if metadata.get("Target").map(String::as_str) != Some(KEYRING_SERVICE) {
                    return None;
                }
                let account_id = metadata
                    .get("acct")
                    .or_else(|| metadata.get("username"))
                    .or_else(|| metadata.get("User"))
                    .or_else(|| metadata.get("user"))
                    .or_else(|| metadata.get("Target"))
                    .or_else(|| metadata.get("target"))?;
                parse_credential_account(account_id)
            })
            .collect();
        summaries.sort_by(|left, right| {
            adapter_key(&left.adapter)
                .cmp(adapter_key(&right.adapter))
                .then_with(|| left.label.cmp(&right.label))
                .then_with(|| left.id.cmp(&right.id))
        });
        summaries.dedup_by(|left, right| left.id == right.id);
        Ok(summaries)
    }

    pub fn set(&self, credential_id: &str, secret: &str) -> Result<(), LlmError> {
        if secret.trim().is_empty() {
            return Err(LlmError::InvalidProfile);
        }
        credential_entry(credential_id)?
            .set_password(secret)
            .map_err(|_| LlmError::Authentication)
    }

    pub fn delete(&self, credential_id: &str) -> Result<(), LlmError> {
        match credential_entry(credential_id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(LlmError::Authentication),
        }
    }
}

pub struct GenaiLlmClient {
    credentials: Arc<dyn CredentialStore>,
}

impl GenaiLlmClient {
    pub fn new(credentials: Arc<dyn CredentialStore>) -> Self {
        Self { credentials }
    }

    pub async fn list_models(&self, profile: &ProviderProfile) -> Result<Vec<String>, LlmError> {
        use genai::resolver::{AuthData, Endpoint, ProviderConfig};

        let adapter = genai_adapter(&profile.adapter, &profile.model);
        let endpoint = profile
            .endpoint
            .as_deref()
            .map(validate_endpoint)
            .transpose()?
            .map(Endpoint::from_owned);
        let auth = match &profile.auth {
            AuthSource::None => AuthData::None,
            AuthSource::Keychain { credential_id } => self
                .credentials
                .get(credential_id)?
                .map(AuthData::from_single)
                .ok_or(LlmError::Authentication)?,
        };
        let provider_config = ProviderConfig::from((endpoint, Some(auth)));
        let client = genai::Client::builder().build();
        let mut models = client
            .all_model_names(adapter, provider_config)
            .await
            .map_err(map_genai_error)?;
        models.sort_unstable();
        models.dedup();
        Ok(models)
    }

    pub async fn check_connection(
        &self,
        profile: &ProviderProfile,
    ) -> Result<Vec<String>, LlmError> {
        match self.list_models(profile).await {
            Ok(models) => Ok(models),
            Err(error) if should_fallback_to_completion(&error, &profile.model) => {
                let mut probe_profile = profile.clone();
                probe_profile.generation.max_tokens = Some(64);
                probe_profile.generation.reasoning_effort = None;
                self.complete(
                    &probe_profile,
                    &[ChatMessage {
                        role: MessageRole::User,
                        content: "Reply with OK.".to_owned(),
                        images: Vec::new(),
                    }],
                )
                .await?;
                Ok(Vec::new())
            }
            Err(error) => Err(error),
        }
    }
}

fn should_fallback_to_completion(error: &LlmError, model: &str) -> bool {
    !model.trim().is_empty() && matches!(error, LlmError::Model | LlmError::ProviderRejected { .. })
}

fn genai_adapter(adapter: &ProviderAdapter, model: &str) -> genai::adapter::AdapterKind {
    use genai::adapter::AdapterKind as GenaiAdapter;

    match adapter {
        ProviderAdapter::OpenAi if model.starts_with("gpt-5") || model.starts_with("gpt-6") => {
            GenaiAdapter::OpenAIResp
        }
        ProviderAdapter::OpenAi => GenaiAdapter::OpenAI,
        ProviderAdapter::OpenAiCompatible => GenaiAdapter::OpenAI,
        ProviderAdapter::Anthropic => GenaiAdapter::Anthropic,
        ProviderAdapter::Gemini => GenaiAdapter::Gemini,
        ProviderAdapter::Ollama => GenaiAdapter::Ollama,
        ProviderAdapter::OpenRouter => GenaiAdapter::OpenRouter,
        ProviderAdapter::Xai => GenaiAdapter::Xai,
        ProviderAdapter::Groq => GenaiAdapter::Groq,
    }
}

fn prepare_request(
    credentials: &Arc<dyn CredentialStore>,
    profile: &ProviderProfile,
    messages: &[ChatMessage],
) -> Result<
    (
        genai::Client,
        String,
        genai::chat::ChatRequest,
        genai::chat::ChatOptions,
    ),
    LlmError,
> {
    use base64::Engine;
    use genai::chat::ContentPart;
    use genai::chat::{ChatMessage as GenaiMessage, ChatOptions, ChatRequest};
    use genai::resolver::{AuthData, Endpoint};
    use genai::{Client, ModelIden, ServiceTarget};

    if profile.model.trim().is_empty()
        || profile
            .generation
            .temperature
            .is_some_and(|temperature| !temperature.is_finite())
        || profile.generation.max_tokens == Some(0)
    {
        return Err(LlmError::InvalidProfile);
    }

    let adapter = genai_adapter(&profile.adapter, &profile.model);
    let endpoint = profile
        .endpoint
        .as_deref()
        .map(validate_endpoint)
        .transpose()?;
    let model_name = profile.model.clone();
    let target_resolver = move |mut target: ServiceTarget| {
        target.model = ModelIden::new(adapter, model_name.clone());
        if let Some(endpoint) = endpoint.as_ref() {
            target.endpoint = Endpoint::from_owned(endpoint.clone());
        }
        Ok(target)
    };

    let auth_source = profile.auth.clone();
    let credentials = Arc::clone(credentials);
    let auth_resolver = move |_| match auth_source.clone() {
        AuthSource::None => Ok(Some(AuthData::None)),
        AuthSource::Keychain { credential_id } => {
            let credential = credentials
                .get(&credential_id)
                .map_err(|_| genai::resolver::Error::Custom("Credential lookup failed".into()))?
                .ok_or_else(|| {
                    genai::resolver::Error::Custom("Credential is unavailable".into())
                })?;
            Ok(Some(AuthData::from_single(credential)))
        }
    };
    let client = Client::builder()
        .with_service_target_resolver_fn(target_resolver)
        .with_auth_resolver_fn(auth_resolver)
        .build();
    let model_for_request = match profile.adapter {
        ProviderAdapter::Groq if !profile.model.starts_with("groq::") => {
            format!("groq::{}", profile.model)
        }
        ProviderAdapter::OpenRouter if !profile.model.starts_with("open_router::") => {
            format!("open_router::{}", profile.model)
        }
        _ => profile.model.clone(),
    };

    let system_prompt = messages
        .iter()
        .filter(|message| message.role == MessageRole::System)
        .map(|message| message.content.as_str())
        .collect::<Vec<_>>()
        .join("\n\n");
    if !messages
        .iter()
        .any(|message| message.role == MessageRole::User)
    {
        return Err(LlmError::InvalidRequest);
    }
    if messages
        .iter()
        .any(|message| !message.images.is_empty() && !profile.capabilities.vision)
    {
        return Err(LlmError::InvalidProfile);
    }

    let mut request = ChatRequest::default();
    if !system_prompt.is_empty() {
        request = request.with_system(system_prompt);
    }
    for message in messages {
        match message.role {
            MessageRole::System => {}
            MessageRole::User => {
                let mut parts = vec![ContentPart::from_text(message.content.clone())];
                for image in &message.images {
                    let encoded = base64::engine::general_purpose::STANDARD.encode(&image.data);
                    parts.push(ContentPart::from_binary_base64(
                        image.mime_type.clone(),
                        encoded,
                        Some(image.name.clone()),
                    ));
                }
                request = request.append_message(GenaiMessage::user(parts));
            }
            MessageRole::Assistant => {
                request = request.append_message(GenaiMessage::assistant(message.content.clone()));
            }
        }
    }

    let mut options = ChatOptions::default();
    if let Some(temperature) = profile.generation.temperature {
        options = options.with_temperature(f64::from(temperature));
    }
    if let Some(max_tokens) = profile.generation.max_tokens {
        options = options.with_max_tokens(max_tokens);
    }
    if let Some(reasoning_effort) = profile.generation.reasoning_effort {
        let reasoning_effort = match reasoning_effort {
            ReasoningEffort::None => genai::chat::ReasoningEffort::None,
            ReasoningEffort::Minimal => genai::chat::ReasoningEffort::Minimal,
            ReasoningEffort::Low => genai::chat::ReasoningEffort::Low,
            ReasoningEffort::Medium => genai::chat::ReasoningEffort::Medium,
            ReasoningEffort::High => genai::chat::ReasoningEffort::High,
            ReasoningEffort::XHigh => genai::chat::ReasoningEffort::XHigh,
            ReasoningEffort::Max => genai::chat::ReasoningEffort::Max,
        };
        options = options.with_reasoning_effort(reasoning_effort);
    }

    Ok((client, model_for_request, request, options))
}

#[async_trait::async_trait]
impl LlmClient for GenaiLlmClient {
    async fn complete(
        &self,
        profile: &ProviderProfile,
        messages: &[ChatMessage],
    ) -> Result<String, LlmError> {
        let (client, model, request, options) =
            prepare_request(&self.credentials, profile, messages)?;
        let response = client
            .exec_chat(&model, request, Some(&options))
            .await
            .map_err(map_genai_error)?;
        let text = response.into_texts().join("");
        if text.trim().is_empty() {
            return Err(LlmError::Model);
        }
        Ok(text)
    }

    async fn stream(
        &self,
        profile: &ProviderProfile,
        messages: &[ChatMessage],
        cancellation: tokio_util::sync::CancellationToken,
        on_delta: &mut (dyn FnMut(String) + Send),
    ) -> Result<String, LlmError> {
        use futures_util::StreamExt;
        use genai::chat::ChatStreamEvent;

        let (client, model, request, options) =
            prepare_request(&self.credentials, profile, messages)?;
        let response = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err(LlmError::Cancelled),
            response = client.exec_chat_stream(&model, request, Some(&options)) => {
                response.map_err(map_genai_error)?
            }
        };
        let mut stream = response.stream;
        let mut output = String::new();

        loop {
            tokio::select! {
                _ = cancellation.cancelled() => return Err(LlmError::Cancelled),
                event = stream.next() => match event {
                    Some(Ok(ChatStreamEvent::Chunk(chunk))) => {
                        output.push_str(&chunk.content);
                        on_delta(chunk.content);
                    }
                    Some(Ok(ChatStreamEvent::End(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(error)) => return Err(map_genai_error(error)),
                }
            }
        }

        if output.trim().is_empty() {
            return Err(LlmError::Model);
        }
        Ok(output)
    }
}

fn validate_endpoint(endpoint: &str) -> Result<String, LlmError> {
    let parsed = url::Url::parse(endpoint).map_err(|_| LlmError::InvalidProfile)?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err(LlmError::InvalidProfile);
    }
    Ok(parsed.to_string())
}

fn map_genai_error(error: genai::Error) -> LlmError {
    match error {
        genai::Error::RequiresApiKey { .. }
        | genai::Error::NoAuthData { .. }
        | genai::Error::NoAuthResolver { .. }
        | genai::Error::Resolver { .. } => LlmError::Authentication,
        genai::Error::HttpError { status, .. } => map_http_status(status.as_u16()),
        genai::Error::WebModelCall { webc_error, .. }
        | genai::Error::WebAdapterCall { webc_error, .. } => map_webc_error(webc_error),
        genai::Error::ChatResponseGeneration { .. }
        | genai::Error::ChatResponse { .. }
        | genai::Error::StreamParse { .. }
        | genai::Error::NoChatResponse { .. } => LlmError::Model,
        _ => LlmError::Network,
    }
}

fn map_webc_error(error: genai::webc::Error) -> LlmError {
    match error {
        genai::webc::Error::ResponseFailedStatus { status, .. } => map_http_status(status.as_u16()),
        genai::webc::Error::ResponseFailedNotJson { .. }
        | genai::webc::Error::ResponseFailedInvalidJson { .. }
        | genai::webc::Error::JsonValueExt(_) => LlmError::Model,
        genai::webc::Error::Reqwest(_) => LlmError::Network,
    }
}

fn map_http_status(status: u16) -> LlmError {
    match status {
        401 | 403 => LlmError::Authentication,
        429 => LlmError::Quota,
        400..=499 => LlmError::ProviderRejected { status },
        _ => LlmError::Network,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        AuthSource, ChatMessage, GenaiLlmClient, GenerationParams, KeyringCredentialStore,
        LlmClient, LlmError, MessageRole, ModelCapabilities, ProviderAdapter, ProviderProfile,
        ReasoningEffort, credential_account_id, credential_entry, genai_adapter, map_http_status,
        parse_credential_account, prepare_request, should_fallback_to_completion,
        validate_endpoint,
    };
    use std::sync::Arc;

    #[test]
    fn chat_message_debug_redacts_clinical_prompt_and_response_text() {
        let message = ChatMessage {
            role: MessageRole::User,
            content: "synthetic clinical secret".to_owned(),
            images: Vec::new(),
        };
        let debug = format!("{message:?}");

        assert!(debug.contains("<redacted>"));
        assert!(!debug.contains("synthetic"));
    }

    #[test]
    fn openai_gpt_five_and_six_use_the_responses_api() {
        use genai::adapter::AdapterKind;

        assert_eq!(
            genai_adapter(&ProviderAdapter::OpenAi, "gpt-6-luna"),
            AdapterKind::OpenAIResp
        );
        assert_eq!(
            genai_adapter(&ProviderAdapter::OpenAi, "gpt-5-mini"),
            AdapterKind::OpenAIResp
        );
        assert_eq!(
            genai_adapter(&ProviderAdapter::OpenAi, "gpt-4o"),
            AdapterKind::OpenAI
        );
        assert_eq!(
            genai_adapter(&ProviderAdapter::OpenAiCompatible, "gpt-6-luna"),
            AdapterKind::OpenAI
        );
    }

    #[test]
    fn provider_profiles_resolve_all_planned_adapters() {
        use genai::adapter::AdapterKind;

        assert_eq!(
            genai_adapter(&ProviderAdapter::OpenRouter, "openai/gpt-4o"),
            AdapterKind::OpenRouter
        );
        assert_eq!(
            genai_adapter(&ProviderAdapter::Xai, "grok-3"),
            AdapterKind::Xai
        );
        assert_eq!(
            genai_adapter(&ProviderAdapter::Groq, "llama-3.3-70b-versatile"),
            AdapterKind::Groq
        );
    }

    #[tokio::test]
    async fn namespaced_provider_models_resolve_their_default_endpoints() {
        struct NoCredentials;

        impl super::CredentialStore for NoCredentials {
            fn get(&self, _credential_id: &str) -> Result<Option<String>, LlmError> {
                Ok(None)
            }
        }

        let credentials: Arc<dyn super::CredentialStore> = Arc::new(NoCredentials);
        let test_cases = [
            (
                ProviderAdapter::Groq,
                "llama-3.3-70b-versatile",
                "groq::llama-3.3-70b-versatile",
                genai::adapter::AdapterKind::Groq,
                "https://api.groq.com/openai/v1/",
            ),
            (
                ProviderAdapter::OpenRouter,
                "openai/gpt-4o",
                "open_router::openai/gpt-4o",
                genai::adapter::AdapterKind::OpenRouter,
                "https://openrouter.ai/api/v1/",
            ),
        ];

        for (adapter, model_name, expected_model, expected_adapter, expected_endpoint) in test_cases
        {
            let profile = ProviderProfile {
                id: "provider".to_owned(),
                display_name: "Provider".to_owned(),
                adapter,
                model: model_name.to_owned(),
                endpoint: None,
                auth: AuthSource::None,
                capabilities: ModelCapabilities {
                    vision: false,
                    streaming: true,
                    max_context: None,
                },
                generation: GenerationParams {
                    temperature: None,
                    max_tokens: Some(1),
                    reasoning_effort: None,
                },
            };
            let (client, model, _, _) = prepare_request(
                &credentials,
                &profile,
                &[ChatMessage {
                    role: MessageRole::User,
                    content: "Reply with OK.".to_owned(),
                    images: Vec::new(),
                }],
            )
            .expect("provider request should be prepared");

            assert_eq!(model, expected_model);
            let target = client
                .resolve_service_target(model.as_str())
                .await
                .expect("model should resolve to its adapter target");
            assert_eq!(target.model.adapter_kind, expected_adapter);
            assert_eq!(target.endpoint.base_url(), expected_endpoint);
        }
    }

    #[test]
    fn http_statuses_are_classified_as_provider_errors() {
        assert_eq!(map_http_status(401), LlmError::Authentication);
        assert_eq!(map_http_status(403), LlmError::Authentication);
        assert_eq!(map_http_status(429), LlmError::Quota);
        assert_eq!(
            map_http_status(400),
            LlmError::ProviderRejected { status: 400 }
        );
        assert_eq!(
            map_http_status(404),
            LlmError::ProviderRejected { status: 404 }
        );
        assert_eq!(
            map_http_status(422),
            LlmError::ProviderRejected { status: 422 }
        );
        assert_eq!(map_http_status(503), LlmError::Network);
    }

    #[test]
    fn provider_profile_round_trips_with_keychain_reference_only() {
        let profile = ProviderProfile {
            id: "local-ollama".to_owned(),
            display_name: "Local Ollama".to_owned(),
            adapter: ProviderAdapter::Ollama,
            model: "qwen2.5-vl".to_owned(),
            endpoint: Some("http://localhost:11434".to_owned()),
            auth: AuthSource::Keychain {
                credential_id: "epikrise/local-ollama".to_owned(),
            },
            capabilities: ModelCapabilities {
                vision: true,
                streaming: true,
                max_context: Some(32_000),
            },
            generation: GenerationParams {
                temperature: Some(0.2),
                max_tokens: Some(4_000),
                reasoning_effort: Some(ReasoningEffort::High),
            },
        };

        let encoded = serde_json::to_value(&profile).expect("profile should serialize");
        assert_eq!(encoded["auth"]["credential_id"], "epikrise/local-ollama");
        assert!(encoded["auth"].get("secret").is_none());
        assert_eq!(encoded["generation"]["max_tokens"], 4_000);
        assert_eq!(encoded["generation"]["reasoning_effort"], "high");
        assert_eq!(
            serde_json::from_value::<ProviderProfile>(encoded).expect("profile should deserialize"),
            profile
        );
    }

    #[test]
    fn rejects_invalid_keychain_credential_ids_before_access() {
        assert!(matches!(
            credential_entry(""),
            Err(LlmError::InvalidProfile)
        ));
        assert!(matches!(
            credential_entry("bad\ncredential"),
            Err(LlmError::InvalidProfile)
        ));
        assert!(matches!(
            credential_entry(&"x".repeat(129)),
            Err(LlmError::InvalidProfile)
        ));
    }

    #[test]
    fn provider_credential_accounts_round_trip() {
        let adapter = ProviderAdapter::OpenAiCompatible;
        let account_id = credential_account_id(&adapter, "Work key")
            .expect("valid provider credential account should format");

        assert_eq!(account_id, "open_ai_compatible:Work key");
        assert_eq!(
            parse_credential_account(&account_id),
            Some(super::CredentialSummary {
                id: account_id,
                adapter,
                label: "Work key".to_owned(),
            })
        );
        assert!(parse_credential_account("legacy-id").is_none());
        assert!(parse_credential_account("unknown:credential").is_none());
    }

    #[test]
    fn rejects_invalid_provider_credential_labels() {
        assert_eq!(
            credential_account_id(&ProviderAdapter::OpenAi, "  "),
            Err(LlmError::InvalidProfile)
        );
        assert_eq!(
            credential_account_id(&ProviderAdapter::OpenAi, "bad\nlabel"),
            Err(LlmError::InvalidProfile)
        );
        assert!(credential_account_id(&ProviderAdapter::OpenAi, &"x".repeat(128)).is_err());
    }

    #[test]
    fn completion_fallback_is_limited_to_model_rejections_with_a_model() {
        assert!(should_fallback_to_completion(&LlmError::Model, "gpt-4o"));
        assert!(should_fallback_to_completion(
            &LlmError::ProviderRejected { status: 404 },
            "gpt-4o"
        ));
        assert!(!should_fallback_to_completion(
            &LlmError::Authentication,
            "gpt-4o"
        ));
        assert!(!should_fallback_to_completion(&LlmError::Network, "gpt-4o"));
        assert!(!should_fallback_to_completion(&LlmError::Model, "  "));
    }

    #[test]
    fn rejects_empty_keychain_secrets() {
        assert_eq!(
            KeyringCredentialStore.set("test", "  "),
            Err(LlmError::InvalidProfile)
        );
    }

    #[test]
    fn generation_settings_reach_genai_chat_options() {
        struct NoCredentials;

        impl super::CredentialStore for NoCredentials {
            fn get(&self, _credential_id: &str) -> Result<Option<String>, LlmError> {
                Ok(None)
            }
        }

        let profile = ProviderProfile {
            id: "test".to_owned(),
            display_name: "Test".to_owned(),
            adapter: ProviderAdapter::OpenAi,
            model: "o3-mini".to_owned(),
            endpoint: None,
            auth: AuthSource::None,
            capabilities: ModelCapabilities {
                vision: false,
                streaming: true,
                max_context: None,
            },
            generation: GenerationParams {
                temperature: None,
                max_tokens: Some(16_384),
                reasoning_effort: Some(ReasoningEffort::High),
            },
        };
        let messages = [ChatMessage {
            role: MessageRole::User,
            content: "Finish the complete report".to_owned(),
            images: Vec::new(),
        }];
        let credentials: Arc<dyn super::CredentialStore> = Arc::new(NoCredentials);

        let (_, _, _, options) = prepare_request(&credentials, &profile, &messages)
            .expect("provider request should be prepared");

        assert_eq!(options.max_tokens, Some(16_384));
        assert!(matches!(
            options.reasoning_effort,
            Some(genai::chat::ReasoningEffort::High)
        ));
    }

    #[test]
    fn image_parts_require_vision_capability_and_are_base64_encoded() {
        struct NoCredentials;

        impl super::CredentialStore for NoCredentials {
            fn get(&self, _credential_id: &str) -> Result<Option<String>, LlmError> {
                Ok(None)
            }
        }

        let mut profile = ProviderProfile {
            id: "vision-test".to_owned(),
            display_name: "Vision test".to_owned(),
            adapter: ProviderAdapter::OpenAi,
            model: "gpt-4o".to_owned(),
            endpoint: None,
            auth: AuthSource::None,
            capabilities: ModelCapabilities {
                vision: true,
                streaming: true,
                max_context: None,
            },
            generation: GenerationParams {
                temperature: None,
                max_tokens: None,
                reasoning_effort: None,
            },
        };
        let messages = [ChatMessage {
            role: MessageRole::User,
            content: "Describe the image".to_owned(),
            images: vec![epikrise_core::ImageAttachment {
                mime_type: "image/png".to_owned(),
                data: vec![1, 2, 3],
                name: "scan.png".to_owned(),
            }],
        }];
        let credentials: Arc<dyn super::CredentialStore> = Arc::new(NoCredentials);
        let (_, _, request, _) = prepare_request(&credentials, &profile, &messages)
            .expect("vision-capable profiles should accept image parts");
        let serialized = serde_json::to_string(&request).expect("request should serialize");
        assert!(serialized.contains("image/png"));
        assert!(serialized.contains("AQID"));

        profile.capabilities.vision = false;
        assert_eq!(
            prepare_request(&credentials, &profile, &messages).map(|_| ()),
            Err(LlmError::InvalidProfile)
        );
    }

    struct FakeClient;

    #[async_trait::async_trait]
    impl LlmClient for FakeClient {
        async fn complete(
            &self,
            profile: &ProviderProfile,
            messages: &[ChatMessage],
        ) -> Result<String, LlmError> {
            let last_message = messages
                .last()
                .map(|message| message.content.as_str())
                .unwrap_or("");
            Ok(format!("{}: {last_message}", profile.model))
        }

        async fn stream(
            &self,
            profile: &ProviderProfile,
            messages: &[ChatMessage],
            cancellation: tokio_util::sync::CancellationToken,
            on_delta: &mut (dyn FnMut(String) + Send),
        ) -> Result<String, LlmError> {
            if cancellation.is_cancelled() {
                return Err(LlmError::Cancelled);
            }
            let response = self.complete(profile, messages).await?;
            on_delta(response.clone());
            Ok(response)
        }
    }

    #[tokio::test]
    async fn fake_client_can_be_injected_without_provider_access() {
        let profile = ProviderProfile {
            id: "test".to_owned(),
            display_name: "Test".to_owned(),
            adapter: ProviderAdapter::OpenAi,
            model: "test-model".to_owned(),
            endpoint: None,
            auth: AuthSource::None,
            capabilities: ModelCapabilities {
                vision: false,
                streaming: false,
                max_context: None,
            },
            generation: GenerationParams {
                temperature: None,
                max_tokens: None,
                reasoning_effort: None,
            },
        };
        let messages = [ChatMessage {
            role: MessageRole::User,
            content: "Summarize these findings".to_owned(),
            images: Vec::new(),
        }];

        let response = FakeClient
            .complete(&profile, &messages)
            .await
            .expect("fake client should return a response");

        assert_eq!(response, "test-model: Summarize these findings");
    }

    #[tokio::test]
    async fn fake_stream_delivers_deltas_and_observes_cancellation() {
        let profile = ProviderProfile {
            id: "test".to_owned(),
            display_name: "Test".to_owned(),
            adapter: ProviderAdapter::OpenAi,
            model: "test-model".to_owned(),
            endpoint: None,
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
        };
        let messages = [ChatMessage {
            role: MessageRole::User,
            content: "hello".to_owned(),
            images: Vec::new(),
        }];
        let mut deltas = Vec::new();
        let cancellation = tokio_util::sync::CancellationToken::new();

        let response = {
            let mut on_delta = |delta| deltas.push(delta);
            FakeClient
                .stream(&profile, &messages, cancellation, &mut on_delta)
                .await
                .expect("fake stream should complete")
        };

        assert_eq!(response, "test-model: hello");
        assert_eq!(deltas, vec!["test-model: hello"]);

        let cancellation = tokio_util::sync::CancellationToken::new();
        cancellation.cancel();
        let mut ignore_delta = |_| {};
        assert_eq!(
            FakeClient
                .stream(&profile, &messages, cancellation, &mut ignore_delta)
                .await,
            Err(LlmError::Cancelled)
        );
    }

    #[tokio::test]
    async fn genai_stream_cancels_before_connecting() {
        let client = GenaiLlmClient::new(std::sync::Arc::new(super::KeyringCredentialStore));
        let profile = ProviderProfile {
            id: "test".to_owned(),
            display_name: "Test".to_owned(),
            adapter: ProviderAdapter::Ollama,
            model: "test-model".to_owned(),
            endpoint: Some("http://127.0.0.1:1".to_owned()),
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
        };
        let messages = [ChatMessage {
            role: MessageRole::User,
            content: "hello".to_owned(),
            images: Vec::new(),
        }];
        let cancellation = tokio_util::sync::CancellationToken::new();
        cancellation.cancel();
        let mut on_delta = |_| {};

        assert_eq!(
            client
                .stream(&profile, &messages, cancellation, &mut on_delta)
                .await,
            Err(LlmError::Cancelled)
        );
    }

    #[test]
    fn custom_endpoint_must_be_http_without_inline_credentials() {
        assert!(validate_endpoint("https://llm.example/v1").is_ok());
        assert_eq!(
            validate_endpoint("file:///etc/passwd"),
            Err(LlmError::InvalidProfile)
        );
        assert_eq!(
            validate_endpoint("https://user:secret@llm.example/v1"),
            Err(LlmError::InvalidProfile)
        );
    }
}
