use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub(crate) struct ProviderRequest {
    /// Legacy model-catalog identifier; never a Node package to load.
    #[serde(default)]
    pub(crate) adapter: Option<String>,
    #[serde(rename = "apiFormat")]
    pub(crate) api_format: String,
    #[serde(default, rename = "providerId")]
    pub(crate) provider_id: Option<String>,
    #[serde(default, rename = "providerOptions")]
    pub(crate) provider_options: Value,
    #[serde(rename = "baseUrl")]
    pub(crate) base_url: Option<String>,
    #[serde(rename = "apiKey", skip_serializing)]
    pub(crate) api_key: Option<String>,
    #[serde(default, skip_serializing)]
    pub(crate) headers: HashMap<String, String>,
    pub(crate) model: String,
    #[serde(default)]
    pub(crate) purpose: Option<String>,
    #[serde(default, rename = "reasoningEffort")]
    pub(crate) reasoning_effort: Option<String>,
    #[serde(default, rename = "reasoningCapable")]
    pub(crate) reasoning_capable: bool,
    #[serde(default, rename = "responseOptions")]
    pub(crate) response_options: Value,
    #[serde(default, rename = "cachePolicy")]
    pub(crate) cache_policy: Value,
    #[serde(default, rename = "maxRetries")]
    pub(crate) max_retries: Option<usize>,
    #[serde(default)]
    pub(crate) prompt: Vec<Value>,
    #[serde(default)]
    pub(crate) tools: Vec<Value>,
    #[serde(rename = "toolChoice")]
    pub(crate) tool_choice: Option<Value>,
    #[serde(rename = "maxOutputTokens")]
    pub(crate) max_output_tokens: Option<u32>,
    #[serde(default)]
    pub(crate) temperature: Option<f64>,
    #[serde(default, rename = "topP")]
    pub(crate) top_p: Option<f64>,
    #[serde(default, rename = "topK")]
    pub(crate) top_k: Option<u32>,
    #[serde(default, rename = "stopSequences")]
    pub(crate) stop_sequences: Vec<String>,
    #[serde(default, rename = "presencePenalty")]
    pub(crate) presence_penalty: Option<f64>,
    #[serde(default, rename = "frequencyPenalty")]
    pub(crate) frequency_penalty: Option<f64>,
    #[serde(default)]
    pub(crate) seed: Option<u64>,
    #[serde(default, rename = "responseFormat")]
    pub(crate) response_format: Option<Value>,
}
