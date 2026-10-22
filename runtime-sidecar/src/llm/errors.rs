use serde_json::Value;

/// Only this error is eligible for model-side argument correction. Never
/// dispatch Rig's partial-object fallback or expose the argument payload.
#[derive(Debug, thiserror::Error)]
#[error(
    "provider returned invalid JSON arguments for tool '{tool_name}' (call '{call_id}'): {detail}"
)]
pub(crate) struct InvalidToolArguments {
    tool_name: String,
    call_id: String,
    detail: String,
}

impl InvalidToolArguments {
    pub(super) fn new(tool_name: &str, call_id: &str, arguments: &str, truncated: bool) -> Self {
        let mut detail = match serde_json::from_str::<Value>(arguments) {
            Err(error) => error.to_string(),
            Ok(Value::String(inner)) => match serde_json::from_str::<Value>(&inner) {
                Err(error) => format!("encoded arguments: {error}"),
                Ok(_) => "expected a JSON object".into(),
            },
            Ok(_) => "expected a JSON object".into(),
        };
        if truncated {
            detail.push_str("; the response reached the output token limit");
        }
        Self {
            tool_name: tool_name.into(),
            call_id: call_id.into(),
            detail,
        }
    }
}

/// DeepSeek-compatible gateways occasionally emit literal newlines, tabs or
/// other control bytes inside a JSON string when a tool argument contains a
/// large source file. JSON requires those bytes to be escaped. Repair only
/// this unambiguous encoding defect; never close missing containers or accept
/// Rig's partial-object fallback, because that could execute truncated code.
pub(super) fn repair_tool_arguments(text: &str) -> Option<serde_json::Map<String, Value>> {
    fn parse(value: &str) -> Option<serde_json::Map<String, Value>> {
        match serde_json::from_str::<Value>(value).ok()? {
            Value::Object(object) => Some(object),
            _ => None,
        }
    }

    let trimmed = text.trim();
    if let Some(object) = parse(trimmed) {
        return Some(object);
    }
    let fenced = trimmed
        .strip_prefix("```json")
        .or_else(|| trimmed.strip_prefix("```JSON"))
        .and_then(|value| value.strip_suffix("```"))
        .map(str::trim);
    if let Some(object) = fenced.and_then(parse) {
        return Some(object);
    }

    let mut repaired = String::with_capacity(trimmed.len() + 32);
    let mut in_string = false;
    let mut escaped = false;
    for ch in trimmed.chars() {
        match ch {
            '"' if !escaped => {
                in_string = !in_string;
                repaired.push('"');
            }
            '\\' if in_string && !escaped => {
                escaped = true;
                repaired.push('\\');
            }
            '\n' if in_string => repaired.push_str("\\n"),
            '\r' if in_string => repaired.push_str("\\r"),
            '\t' if in_string => repaired.push_str("\\t"),
            ch if in_string && ch.is_control() => {
                repaired.push_str(&format!("\\u{:04x}", ch as u32));
            }
            ch => {
                repaired.push(ch);
                escaped = false;
            }
        }
        if escaped && ch != '\\' {
            escaped = false;
        }
    }
    parse(&repaired)
}

#[cfg(test)]
mod tests {
    use super::repair_tool_arguments;

    #[test]
    fn repairs_literal_control_bytes_inside_large_code_strings() {
        let repaired = repair_tool_arguments(
            "{\"path\":\"game.html\",\"content\":\"const title = \\\"鹈鹕\\\";\nconsole.log(title);\"}",
        )
        .expect("literal newline should be escaped");
        assert_eq!(repaired["path"], "game.html");
        assert_eq!(
            repaired["content"],
            "const title = \"鹈鹕\";\nconsole.log(title);"
        );
    }

    #[test]
    fn never_repairs_a_truncated_object() {
        assert!(
            repair_tool_arguments("{\"path\":\"game.html\",\"content\":\"const x = 1").is_none()
        );
    }

    #[test]
    fn strips_json_code_fences_without_changing_unicode() {
        let repaired = repair_tool_arguments("```json\n{\"text\":\"中文\"}\n```").unwrap();
        assert_eq!(repaired["text"], "中文");
    }
}
