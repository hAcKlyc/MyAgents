// Desired-state list policy shared with src/shared/mcpSelection.ts. Keep the
// fixture parity test in sync; mcpServersJson remains a serialized JSON string.
pub(crate) fn normalize_mcp_selection_field(value: &mut serde_json::Value) -> bool {
    use serde_json::Value;
    let Some(obj) = value.as_object_mut() else {
        return false;
    };
    let Some(current) = obj.get("mcpEnabledServers") else {
        return false;
    };
    if current.is_null() {
        obj.remove("mcpEnabledServers");
        return true;
    }
    let parsed = if let Some(text) = current.as_str() {
        let text = text.trim();
        match serde_json::from_str::<Value>(text) {
            Ok(parsed) => parsed,
            // JSON.parse accepts overflowing numbers as Infinity; those arrays
            // fail the string-only check in TypeScript. Validate syntax without
            // materializing numbers so Rust never reinterprets them as IDs.
            Err(_) if serde_json::from_str::<serde::de::IgnoredAny>(text).is_ok() => {
                serde_json::json!([])
            }
            Err(_) => {
                let ids = text
                    .strip_prefix('[')
                    .and_then(|text| text.strip_suffix(']'))
                    .map(|inner| inner.split(',').map(str::trim).collect::<Vec<_>>());
                match ids {
                    Some(ids)
                        if ids.iter().all(|id| {
                            !id.is_empty()
                                && id
                                    .bytes()
                                    .all(|b| b.is_ascii_alphanumeric() || b"_./:@+-".contains(&b))
                        }) =>
                    {
                        serde_json::json!(ids)
                    }
                    _ => serde_json::json!([]),
                }
            }
        }
    } else {
        current.clone()
    };
    let normalized = match parsed.as_array() {
        Some(ids) if ids.iter().all(Value::is_string) => parsed,
        _ => serde_json::json!([]),
    };
    if *current == normalized {
        return false;
    }
    obj.insert("mcpEnabledServers".to_string(), normalized);
    true
}

pub(crate) fn normalize_config_mcp_selections(value: &mut serde_json::Value) -> bool {
    let mut changed = normalize_mcp_selection_field(value);
    for key in ["agents", "projects", "imBotConfigs"] {
        if let Some(holders) = value.get_mut(key).and_then(serde_json::Value::as_array_mut) {
            for holder in holders {
                changed |= normalize_mcp_selection_field(holder);
            }
        }
    }
    for key in ["launcherLastUsed", "imBotConfig"] {
        if let Some(holder) = value.get_mut(key) {
            changed |= normalize_mcp_selection_field(holder);
        }
    }
    changed
}
