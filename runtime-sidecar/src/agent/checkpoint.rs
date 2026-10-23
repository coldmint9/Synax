//! Bounded semantic state and a logical history boundary. No transcript copies.
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

pub(crate) const MAX_CHECKPOINT_BYTES: usize = 128 * 1024;
pub(crate) const MAX_SUMMARY_TOKENS: usize = 12_000;
pub(crate) const MAX_SOURCE_REFS: usize = 64;
const MAX_ID_BYTES: usize = 256;
const MAX_SAFE_REVISION: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StructuredSummary {
    pub goal: Vec<String>,
    pub constraints: Vec<String>,
    pub decisions: Vec<String>,
    pub completed_work: Vec<String>,
    pub evidence: Vec<String>,
    pub failures: Vec<String>,
    pub open_questions: Vec<String>,
    pub next_actions: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ContextCheckpoint {
    pub version: u8,
    pub id: String,
    pub session_id: String,
    pub compaction_run_id: String,
    pub through_revision: u64,
    pub through_step_id: String,
    pub summary: StructuredSummary,
    pub source_refs: Vec<String>,
    pub source_fingerprint: String,
    pub created_at: String,
}

impl ContextCheckpoint {
    /// Limit bytes before decoding and tokenizing. Work is bounded regardless
    /// of the size/revision of the session to which this record belongs.
    pub(crate) fn parse(encoded: &[u8], summary_budget: usize) -> Result<Self, &'static str> {
        if encoded.len() > MAX_CHECKPOINT_BYTES {
            return Err("checkpoint_too_large");
        }
        if summary_budget == 0 || summary_budget > MAX_SUMMARY_TOKENS {
            return Err("invalid_checkpoint_budget");
        }
        let checkpoint: Self = serde_json::from_slice(encoded).map_err(|_| "invalid_checkpoint")?;
        checkpoint.validate(summary_budget)?;
        Ok(checkpoint)
    }

    fn validate(&self, summary_budget: usize) -> Result<(), &'static str> {
        let valid_id = |s: &str| !s.is_empty() && s.len() <= MAX_ID_BYTES;
        if self.version != 1
            || self.through_revision > MAX_SAFE_REVISION
            || ![&self.id, &self.session_id, &self.compaction_run_id, &self.through_step_id]
                .iter().all(|id| valid_id(id))
            || self.source_fingerprint.len() != 64
            || !self.source_fingerprint.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || chrono::DateTime::parse_from_rfc3339(&self.created_at).is_err()
        {
            return Err("invalid_checkpoint");
        }
        if self.source_refs.len() > MAX_SOURCE_REFS
            || self.source_refs.iter().any(|id| !valid_id(id))
            || self.source_refs.iter().collect::<HashSet<_>>().len() != self.source_refs.len()
        {
            return Err("invalid_checkpoint_refs");
        }
        let s = &self.summary;
        for entries in [&s.goal, &s.constraints, &s.decisions, &s.completed_work,
            &s.evidence, &s.failures, &s.open_questions, &s.next_actions]
        {
            if entries.len() > 128 || entries.iter().any(|text| text.is_empty() || text.encode_utf16().count() > 16_384) {
                return Err("invalid_checkpoint_summary");
            }
        }
        let text = serde_json::to_string(&self.summary).map_err(|_| "invalid_checkpoint_summary")?;
        if crate::llm::tokenizer::tokens(&text) > summary_budget {
            return Err("checkpoint_summary_exceeds_budget");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn fixture() -> Value {
        json!({"version":1,"id":"cmp-1","sessionId":"session","compactionRunId":"run-compact",
            "throughRevision":15,"throughStepId":"step-10",
            "summary":{"goal":["Investigate the error"],"constraints":["Keep the source history"],
                "decisions":[],"completedWork":[],"evidence":["step-10: observed failure"],
                "failures":[],"openQuestions":[],"nextActions":["Read step-10"]},
            "sourceRefs":["step-10"],"sourceFingerprint":"a".repeat(64),"createdAt":"2026-10-23T08:00:00Z"})
    }
    fn parse(value: &Value) -> Result<ContextCheckpoint, &'static str> {
        ContextCheckpoint::parse(&serde_json::to_vec(value).unwrap(), MAX_SUMMARY_TOKENS)
    }

    #[test]
    fn accepts_only_bounded_state_and_log_boundaries() {
        let checkpoint = parse(&fixture()).unwrap();
        assert_eq!(checkpoint.through_revision, 15);
        for field in ["historyIndex", "transcript", "previousCheckpoint"] {
            let mut value = fixture();
            value[field] = json!([]);
            assert!(parse(&value).is_err());
        }
    }

    #[test]
    fn rejects_unbounded_or_duplicate_references() {
        for refs in [json!(["step-10", "step-10"]), json!(["文".repeat(86)]),
            json!((0..65).map(|n| format!("step-{n}")).collect::<Vec<_>>())] {
            let mut value = fixture();
            value["sourceRefs"] = refs;
            assert_eq!(parse(&value), Err("invalid_checkpoint_refs"));
        }
    }

    #[test]
    fn encoded_and_token_limits_are_independent() {
        assert_eq!(ContextCheckpoint::parse(&vec![b' '; MAX_CHECKPOINT_BYTES + 1], 100), Err("checkpoint_too_large"));
        assert_eq!(ContextCheckpoint::parse(&serde_json::to_vec(&fixture()).unwrap(), 1), Err("checkpoint_summary_exceeds_budget"));
        assert_eq!(ContextCheckpoint::parse(b"{}", 0), Err("invalid_checkpoint_budget"));
    }

    #[test]
    fn record_size_does_not_track_history_size() {
        let mut sizes = Vec::new();
        for revision in [10, 10_000, 10_000_000] {
            let mut value = fixture();
            value["throughRevision"] = json!(revision);
            parse(&value).unwrap();
            sizes.push(serde_json::to_vec(&value).unwrap().len());
        }
        assert!(sizes[2] - sizes[0] < 10);
    }
}
