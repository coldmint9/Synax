use super::*;
use serde_json::json;

fn row(id: &str, status: &str) -> ListRecord {
    ListRecord { s: id.into(), u: id.into(), del: false, h: json!({
        "id":id,"projectId":"p","profileId":"synax","status":status,"updatedAt":id,
        "parentSessionId":null,"sessionMetadata":{
            "pinned":true,"runtimeControl":{"state":"stopping"},
            "mcpToolDefinitions":{"schema":"x".repeat(190_000)},
            "latestSystemPrompt":"y".repeat(100_000),"inputQueue":[{"text":"queued"}]
        }
    }) }
}

#[test]
fn encoded_views_page_without_detail_artifacts_and_follow_updates_and_deletions() {
    let mut index = ListIndex::default();
    for i in 0..130 { index.upsert(row(&format!("s-{i:03}"), "running")); }
    for badges in [false, true] {
        let mut cursor = None;
        let mut ids = Vec::new();
        let mut bytes = 0;
        loop {
            let page = index.page_json(cursor.as_ref(), badges);
            bytes += page.len();
            let page: Value = serde_json::from_slice(&page).unwrap();
            for item in page["items"].as_array().unwrap() {
                assert!(item["sessionMetadata"].get("mcpToolDefinitions").is_none());
                assert!(item["sessionMetadata"].get("inputQueue").is_none());
                assert_eq!(item["sessionMetadata"]["runtimeControl"]["state"], "stopping");
                assert_eq!(item["sessionMetadata"].get("pinned").is_some(), !badges);
                ids.push(item["id"].as_str().unwrap().to_owned());
            }
            cursor = page["next"].as_str().and_then(ListIndex::decode_cursor);
            if cursor.is_none() { break; }
        }
        assert_eq!(ids.len(), 130);
        ids.sort(); ids.dedup(); assert_eq!(ids.len(), 130);
        assert!(bytes < 60_000, "transport size must be independent of tool schemas");
    }
    index.upsert(row("s-129", "completed"));
    let page: Value = serde_json::from_slice(&index.page_json(None, true)).unwrap();
    assert_eq!(page["items"][0]["status"], "completed");
    let mut deleted = row("s-129", "completed"); deleted.del = true;
    index.upsert(deleted);
    assert!(index.get("s-129").is_none());
    assert_eq!(index.len(), 129);
    index.set_recovery_required("s-128", true);
    let page: Value = serde_json::from_slice(&index.page_json(None, false)).unwrap();
    assert_eq!(page["items"][0]["runtimeRecoveryRequired"], true);
}
