use super::{Error, contract::ProviderRequest};
use rig_core::{
    DynModel,
    operation::Completion,
    providers::{anthropic::AnthropicConfig, openai::OpenAIConfig},
};

pub(super) fn model(input: &ProviderRequest) -> Result<DynModel<Completion>, Error> {
    let extra = crate::llm::metadata::RequestMetadata::new(input)?;
    let key = input.api_key.clone().unwrap_or_default();
    if input.api_format == "anthropic" {
        let mut config = AnthropicConfig::new(key);
        if let Some(base) = &input.base_url {
            config = config.with_base_url(base);
        }
        let mut model = config.client().completion(&input.model);
        model.transport = model.transport.with_middleware(extra);
        Ok(model.erase())
    } else {
        let mut config = OpenAIConfig::new(key);
        if let Some(base) = &input.base_url {
            config = config.with_base_url(
                base.trim_end_matches('/')
                    .trim_end_matches("/responses")
                    .trim_end_matches("/chat/completions"),
            );
        }
        match input.api_format.as_str() {
            "openai" => {
                let mut model = config.client().chat(&input.model);
                model.transport = model.transport.with_middleware(extra);
                Ok(model.erase())
            }
            "openai-responses" => {
                let mut model = config.client().responses(&input.model);
                model.transport = model.transport.with_middleware(extra);
                Ok(model.erase())
            }
            other => Err(format!("unsupported provider protocol '{other}'").into()),
        }
    }
}
