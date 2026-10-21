//! Native media transport. The host supplies inline assets and stores returned bytes.
use base64::{Engine, engine::general_purpose::STANDARD};
use futures_util::{StreamExt, stream::BoxStream};
use reqwest::{
    Client, RequestBuilder, Response,
    multipart::{Form, Part},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};
use std::time::Duration;

type Error = Box<dyn std::error::Error + Send + Sync>;
const MAX_FILE_BYTES: usize = 100 * 1024 * 1024;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaRequest {
    operation: String,
    provider_id: String,
    adapter: Option<String>,
    base_url: Option<String>,
    api_key: Option<String>,
    #[serde(default)]
    headers: HashMap<String, String>,
    model: String,
    conversation_model: Option<String>,
    #[serde(default)]
    options: Value,
    #[serde(default)]
    files: Vec<MediaFile>,
    mask: Option<MediaFile>,
    max_retries: Option<usize>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MediaFile {
    data: String,
    media_type: String,
    filename: String,
}
impl MediaFile {
    fn bytes(&self) -> Result<Vec<u8>, Error> {
        let bytes = STANDARD.decode(&self.data)?;
        if bytes.is_empty() || bytes.len() > MAX_FILE_BYTES {
            return Err("Media exceeds the file limit".into());
        }
        Ok(bytes)
    }
    fn part(&self) -> Result<Part, Error> {
        Ok(Part::bytes(self.bytes()?)
            .file_name(self.filename.clone())
            .mime_str(&self.media_type)?)
    }
    fn data_url(&self) -> String {
        format!("data:{};base64,{}", self.media_type, self.data)
    }
}

impl MediaRequest {
    fn url(&self, path: &str) -> String {
        format!(
            "{}/{}",
            self.base_url
                .as_deref()
                .unwrap_or("https://api.openai.com/v1")
                .trim_end_matches('/'),
            path
        )
    }
    fn headers(&self, mut request: RequestBuilder) -> RequestBuilder {
        if let Some(key) = &self.api_key {
            request = request.bearer_auth(key);
        }
        for (key, value) in &self.headers {
            request = request.header(key, value);
        }
        request
    }
    fn extra(&self) -> Value {
        let mut extra = json!({});
        for namespace in ["openai", self.provider_id.as_str()] {
            if let Some(options) = self.options["providerOptions"][namespace].as_object() {
                extra.as_object_mut().unwrap().extend(options.clone());
            }
        }
        extra
    }
}

pub(crate) fn events(input: MediaRequest) -> BoxStream<'static, Result<Value, Error>> {
    let span = tracing::error_span!("provider", provider_request_id = %uuid::Uuid::new_v4(),
        provider_id = %input.provider_id, model = %input.model, operation = %input.operation);
    let retries = input
        .max_retries
        .unwrap_or(super::retry::MAX_RETRIES)
        .min(super::retry::MAX_RETRIES);
    crate::logging::observe_stream(super::retry::with_retry(move || events_once(input.clone()), retries), span)
}

async fn send(request: RequestBuilder) -> Result<Response, Error> {
    let response = request.send().await?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await?;
        return Err(rig_core::error::ProviderError::from_http_response(status, body).into());
    }
    Ok(response)
}

fn events_once(input: MediaRequest) -> BoxStream<'static, Result<Value, Error>> {
    Box::pin(async_stream::try_stream! {
        if input.adapter.as_deref().is_some_and(|adapter| !matches!(adapter, "@ai-sdk/openai" | "@ai-sdk/openai-compatible")) {
            Err(format!("Provider '{}' has no native {} adapter", input.provider_id, input.operation))?;
        }
        let client = Client::builder().connect_timeout(Duration::from_secs(30)).build()?;
        match input.operation.as_str() {
            "images" => {
                let responses = input.options["api"] == "responses";
                let sdk = input.options["api"] == "sdk" || input.options["api"] == "native";
                let streaming = input.options["stream"].as_bool().unwrap_or(!sdk);
                if sdk && (streaming || !input.options["partialImages"].is_null()) {
                    Err("This native image adapter does not expose partial-image streaming; use api=images or responses")?;
                }
                let n = input.options["n"].as_u64().unwrap_or(1) as usize;
                if !(1..=10).contains(&n) { Err("Image count must be between 1 and 10")?; }
                if responses && n != 1 { Err("Responses image generation produces one image per call")?; }
                if input.options["aspectRatio"].is_string() || !input.options["seed"].is_null() {
                    Err("This image protocol uses size; aspectRatio and seed are not supported")?;
                }
                let format = input.options["outputFormat"].as_str().unwrap_or("png");
                let mut controls = input.extra();
                for (source, target) in [("size","size"),("quality","quality"),("background","background"),("outputFormat","output_format"),
                    ("outputCompression","output_compression"),("moderation","moderation"),("inputFidelity","input_fidelity")] {
                    if let Some(value) = input.options.get(source) { controls[target] = value.clone(); }
                }
                if streaming { controls["partial_images"] = input.options.get("partialImages").cloned().unwrap_or(json!(1)); }
                let request = if responses {
                    controls["type"] = json!("image_generation");
                    controls["model"] = json!(input.model);
                    controls["action"] = json!(if input.files.is_empty() { "generate" } else { "edit" });
                    if let Some(mask) = &input.mask { controls["input_image_mask"] = json!({"image_url":mask.data_url()}); }
                    let mut content = vec![json!({"type":"input_text","text":input.options["prompt"]})];
                    for file in &input.files { file.bytes()?; content.push(json!({"type":"input_image","image_url":file.data_url()})); }
                    let conversation_model = input.conversation_model.as_deref().ok_or("Responses image generation requires a conversation model")?;
                    let body = json!({"model":conversation_model,
                        "input":[{"role":"user","content":content}],"tools":[controls],"tool_choice":{"type":"image_generation"},"stream":streaming});
                    input.headers(client.post(input.url("responses"))).json(&body)
                } else {
                    controls["model"] = json!(input.model);
                    controls["prompt"] = input.options["prompt"].clone();
                    controls["n"] = json!(n);
                    if sdk {
                        controls["response_format"] = json!("b64_json");
                        controls.as_object_mut().unwrap().remove("output_format");
                        controls.as_object_mut().unwrap().remove("background");
                        if controls["quality"] == "auto" { controls.as_object_mut().unwrap().remove("quality"); }
                        if controls["size"] == "auto" { controls.as_object_mut().unwrap().remove("size"); }
                    } else { controls["stream"] = json!(streaming); }
                    if input.files.is_empty() { input.headers(client.post(input.url("images/generations"))).json(&controls) }
                    else {
                        let mut form = Form::new();
                        for (key, value) in controls.as_object().unwrap() {
                            if !value.is_null() { form = form.text(key.clone(), value.as_str().map(str::to_owned).unwrap_or_else(|| value.to_string())); }
                        }
                        for file in &input.files { form = form.part("image[]", file.part()?); }
                        if let Some(mask) = &input.mask { form = form.part("mask", mask.part()?); }
                        input.headers(client.post(input.url("images/edits"))).multipart(form)
                    }
                };
                let response = send(request).await?;
                let mut completed = BTreeMap::<String, Value>::new();
                let mut count = 0;
                let mut usage = Value::Null;
                if !streaming {
                    let body: Value = response.json().await?;
                    usage = body["usage"].clone();
                    let items = if responses { &body["output"] } else { &body["data"] };
                    for (index, item) in items.as_array().ok_or("Image response has no image batch")?.iter().enumerate() {
                        if responses && item["type"] != "image_generation_call" { continue; }
                        let file = image_file(if responses { &item["result"] } else { &item["b64_json"] }, item["output_format"].as_str().unwrap_or(format), item.get("revised_prompt"))?;
                        completed.insert(index.to_string(), file);
                    }
                } else {
                    if !response.headers().get("content-type").and_then(|v|v.to_str().ok()).is_some_and(|v|v.contains("text/event-stream")) {
                        Err("Image API did not return the requested image stream")?;
                    }
                    let mut stream = sse(response);
                    while let Some(event) = stream.next().await {
                        let event = event?;
                        let kind = event["type"].as_str().unwrap_or_default();
                        if !event["error"].is_null() || kind == "error" || kind.ends_with(".failed") {
                            Err(format!("Image generation failed: {}", event.get("message").unwrap_or(&event["error"])))?;
                        }
                        if kind.ends_with(".partial_image") {
                            let data = if responses { &event["partial_image_b64"] } else { &event["b64_json"] };
                            let file = image_file(data, event["output_format"].as_str().unwrap_or(format), None)?;
                            yield json!({"type":"media-partial","file":file});
                        } else if responses {
                            let items = if kind == "response.output_item.done" { vec![event["item"].clone()] }
                                else if kind == "response.completed" { usage=event["response"]["usage"].clone(); event["response"]["output"].as_array().cloned().unwrap_or_default() } else { vec![] };
                            for item in items {
                                if item["type"] == "image_generation_call" && item["status"] == "completed" {
                                    completed.insert(item["id"].as_str().ok_or("Image result is missing its ID")?.to_owned(), image_file(&item["result"], format, None)?);
                                }
                            }
                        } else if matches!(kind, "image_generation.completed" | "image_edit.completed") {
                            completed.insert(count.to_string(), image_file(&event["b64_json"], event["output_format"].as_str().unwrap_or(format), event.get("revised_prompt"))?);
                            count+=1;
                            if !event["usage"].is_null() { usage=event["usage"].clone(); }
                        }
                    }
                }
                if completed.len() != n { Err("Image stream ended before the complete image batch arrived")?; }
                yield json!({"type":"media-result","files":completed.into_values().collect::<Vec<_>>(),"usage":usage,"warnings":[]});
            }
            "speech" => {
                let mut body = input.extra();
                body["model"] = json!(input.model);
                body["input"] = input.options["text"].clone();
                body["voice"] = input.options.get("voice").cloned().unwrap_or(json!("alloy"));
                let format=input.options["outputFormat"].as_str().unwrap_or("mp3");
                body["response_format"] = json!(format);
                for key in ["instructions","speed"] { if let Some(value)=input.options.get(key) {body[key]=value.clone();} }
                let bytes=send(input.headers(client.post(input.url("audio/speech"))).json(&body)).await?.bytes().await?;
                if bytes.is_empty() || bytes.len()>MAX_FILE_BYTES { Err("Generated audio exceeds the file limit")?; }
                let media=if format=="mp3" { "audio/mpeg".to_owned() } else { format!("audio/{format}") };
                yield json!({"type":"media-result","files":[{"data":STANDARD.encode(bytes),"mediaType":media}],"warnings":[]});
            }
            "transcribe" => {
                let file=input.files.first().ok_or("Transcription requires an audio file")?;
                let mut form=Form::new().text("model",input.model.clone()).part("file",file.part()?);
                for (key,value) in input.extra().as_object().unwrap() {form=form.text(key.clone(),value.as_str().map(str::to_owned).unwrap_or_else(||value.to_string()));}
                let result:Value=send(input.headers(client.post(input.url("audio/transcriptions"))).multipart(form)).await?.json().await?;
                yield json!({"type":"media-result","text":result["text"],"language":result["language"],"segments":result["segments"],"durationInSeconds":result["duration"],"warnings":[]});
            }
            // Existing configured adapters exposed images/speech/transcription only.
            // Do not silently map unsupported video controls onto an image endpoint.
            "video" => Err(format!("Provider '{}' has no native video generation adapter", input.provider_id))?,
            other => Err(format!("Unsupported media operation '{other}'"))?,
        }
    })
}

fn image_file(data: &Value, format: &str, revised: Option<&Value>) -> Result<Value, Error> {
    let data = data
        .as_str()
        .ok_or("Image stream event has no image data")?;
    let bytes = STANDARD
        .decode(data)
        .map_err(|_| "Image API returned invalid base64")?;
    if bytes.is_empty() || bytes.len() > MAX_FILE_BYTES {
        return Err("Generated image exceeds the file limit".into());
    }
    Ok(
        json!({"data":data,"format":format,"mediaType":format!("image/{format}"),"revisedPrompt":revised}),
    )
}

/// Decode SSE across arbitrary TCP and UTF-8 boundaries with a bounded event buffer.
fn sse(response: Response) -> BoxStream<'static, Result<Value, Error>> {
    Box::pin(async_stream::try_stream! {
        let mut bytes=response.bytes_stream();
        let mut line=Vec::new();
        let mut data=String::new();
        while let Some(chunk)=bytes.next().await {
            for byte in chunk? {
                if byte==b'\n' {
                    if line.last()==Some(&b'\r') {line.pop();}
                    let text=std::str::from_utf8(&line)?;
                    if text.is_empty() {
                        if !data.is_empty() && data.trim()!="[DONE]" {yield serde_json::from_str::<Value>(&data)?;}
                        data.clear();
                    } else if let Some(value)=text.strip_prefix("data:") {
                        if !data.is_empty(){data.push('\n');}
                        data.push_str(value.strip_prefix(' ').unwrap_or(value));
                    }
                    line.clear();
                } else {line.push(byte);}
                if line.len()+data.len()>MAX_FILE_BYTES*2 {Err("Media stream event exceeds the file limit")?;}
            }
        }
        if !line.is_empty() || !data.is_empty() {Err("Media stream ended with an incomplete event")?;}
    })
}
