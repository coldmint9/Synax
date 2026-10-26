//! Native workflow decisions. Inputs are persisted runtime facts, never model
//! claims of acceptance. The host only projects the resulting disposition.
use serde::{Deserialize, Serialize};
use serde_json::Value;

const CONTROL_TOOLS: &[&str] = &[
    "human.ask",
    "plan.propose",
    "plan.execute",
    "mode.switch",
    "goal.finish",
    "work.checkpoint",
    "design.implement",
    "command.manage",
];

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeBinding {
    pub session_id: String,
    pub run_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Disposition {
    pub status: String,
    pub reason: String,
    pub summary: String,
}

pub(crate) enum Decision {
    Continue,
    Correct(String),
    Finish(Disposition),
}

fn finish(status: &str, reason: &str, summary: &str) -> Decision {
    Decision::Finish(Disposition {
        status: status.into(),
        reason: reason.into(),
        summary: summary.into(),
    })
}

/// State wins over model output. Completed goals are only accepted after the
/// evidence gate has persisted their terminal state.
pub(crate) fn before_model(session: &Value, root: &Value, run: &Value) -> Decision {
    if session
        .pointer("/sessionMetadata/runtimeControl")
        .is_some_and(|control| !control.is_null())
        || root
            .pointer("/sessionMetadata/runtimeControl")
            .is_some_and(|control| !control.is_null())
    {
        return finish(
            "interrupted",
            "execution_stopping",
            "Execution shutdown was requested.",
        );
    }
    if matches!(
        session["status"].as_str(),
        Some("paused" | "interrupted" | "cancelled")
    ) || matches!(
        root["status"].as_str(),
        Some("paused" | "interrupted" | "cancelled")
    ) {
        return finish(
            "interrupted",
            "session_stopped",
            "Session was stopped by the user.",
        );
    }
    if let Some(handoff) = run.pointer("/metadata/roundHandoff") {
        if let Some(summary) = handoff["summary"].as_str() {
            return finish("completed", "round_yielded", summary);
        }
    }
    if root
        .pointer("/sessionMetadata/mode")
        .and_then(Value::as_str)
        == Some("goal")
    {
        let goal = &root["sessionMetadata"]["goal"];
        let reason = goal["reason"].as_str().unwrap_or("Goal stopped.");
        match goal["status"].as_str() {
            Some("completed") => {
                if goal["acceptanceEvidence"]
                    .as_array()
                    .is_none_or(|items| items.is_empty())
                {
                    return finish(
                        "failed",
                        "invalid_goal_acceptance",
                        "Completed goal has no persisted acceptance evidence.",
                    );
                }
                return finish(
                    "completed",
                    "goal_completed",
                    goal["reason"]
                        .as_str()
                        .unwrap_or("Goal completed with acceptance evidence."),
                );
            }
            Some("blocked" | "budget_exhausted" | "cancelled") => {
                return finish("blocked", "goal_stopped", reason);
            }
            _ => {}
        }
    }
    if matches!(
        run["status"].as_str(),
        Some("completed" | "blocked" | "failed" | "interrupted" | "cancelled")
    ) {
        return finish(
            run["status"].as_str().unwrap(),
            run["stopReason"].as_str().unwrap_or("completed"),
            session["resultSummary"].as_str().unwrap_or("Run settled."),
        );
    }
    Decision::Continue
}

pub(crate) fn final_answer(session: &Value, root: &Value, run: &Value, text: &str) -> Decision {
    let decision = before_model(session, root, run);
    if !matches!(decision, Decision::Continue) {
        return decision;
    }
    if run.pointer("/metadata/commandTasks").and_then(Value::as_array).is_some_and(|tasks|
        tasks.iter().any(|task| task["state"] != "settled" || task["deliveredStep"].is_null())) {
        return Decision::Correct("Commands are still running or completion results are queued. Assess dependencies with command.manage, continue independent work after backgrounding, or wait. Aggregate completion results from the next step before finishing.".into());
    }
    if text.trim().is_empty() {
        return Decision::Correct(
            "An empty response cannot complete this turn. Provide a result or a concrete blocker."
                .into(),
        );
    }
    let root_goal = session["parentSessionId"].is_null()
        && root
            .pointer("/sessionMetadata/mode")
            .and_then(Value::as_str)
            == Some("goal")
        && root
            .pointer("/sessionMetadata/goal")
            .is_some_and(Value::is_object);
    if root_goal {
        return Decision::Correct("This goal is still active. A plain-text answer does not satisfy acceptance. Continue the approved plan, use goal.finish with current criterion evidence, or report a real blocker with work.checkpoint. If another round is needed, yield a factual handoff without claiming the goal is complete.".into());
    }
    finish("completed", "completed", text)
}

pub(crate) fn validate_tool_batch(events: &[Value]) -> Option<&'static str> {
    let calls: Vec<_> = events
        .iter()
        .filter(|event| event["type"] == "tool-call")
        .collect();
    (calls.len() > 1 && calls.iter().any(|call| CONTROL_TOOLS.contains(&call["toolName"].as_str().unwrap_or_default())))
        .then_some("Control tools must be the only call in a step. No operation from this batch was executed. Submit the control operation separately.")
}

pub(crate) fn interaction_result(tool_name: &str, result: &Value) -> Option<Disposition> {
    let (status, reason, summary) = match (tool_name, result["action"].as_str()) {
        ("plan.propose" | "plan.execute", Some("save" | "cancel")) => {
            ("completed", "plan_saved", "Plan saved for later execution.")
        }
        ("human.ask", Some("cancel")) => (
            "blocked",
            "input_cancelled",
            "User cancelled the requested input.",
        ),
        _ => return None,
    };
    Some(Disposition {
        status: status.into(),
        reason: reason.into(),
        summary: summary.into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn running() -> Value {
        json!({"id":"s","parentSessionId":null,"status":"running","sessionMetadata":{"mode":"chat"}})
    }
    #[test]
    fn plain_text_cannot_accept_an_active_root_goal() {
        let mut session = running();
        session["sessionMetadata"] = json!({"mode":"goal","goal":{"status":"executing"}});
        assert!(matches!(
            final_answer(&session, &session, &json!({"status":"running"}), "Done"),
            Decision::Correct(_)
        ));
        session["sessionMetadata"]["goal"] = json!({"status":"completed","acceptanceEvidence":[{"criterion":"test","summary":"passed"}]});
        assert!(
            matches!(before_model(&session, &session, &json!({})), Decision::Finish(Disposition{reason,..}) if reason == "goal_completed")
        );
    }
    #[test]
    fn chat_and_children_do_not_inherit_root_acceptance() {
        let session = running();
        assert!(matches!(
            final_answer(&session, &session, &json!({}), "Partial result"),
            Decision::Finish(_)
        ));
        let mut child = session.clone();
        child["parentSessionId"] = json!("parent");
        let mut root = session.clone();
        root["sessionMetadata"] = json!({"mode":"goal","goal":{"status":"executing"}});
        assert!(matches!(
            final_answer(&child, &root, &json!({}), "Child result"),
            Decision::Finish(_)
        ));
    }
    #[test]
    fn saved_plans_and_cancelled_forms_have_distinct_terminal_results() {
        assert_eq!(
            interaction_result("plan.propose", &json!({"action":"save"}))
                .unwrap()
                .reason,
            "plan_saved"
        );
        assert_eq!(
            interaction_result("human.ask", &json!({"action":"cancel"}))
                .unwrap()
                .status,
            "blocked"
        );
        assert!(interaction_result("human.ask", &json!({"action":"skip"})).is_none());
        assert!(interaction_result("plan.propose", &json!({"action":"execute"})).is_none());
    }
    #[test]
    fn mixed_control_batches_are_rejected_before_execution() {
        assert!(
            validate_tool_batch(&[
                json!({"type":"tool-call","toolName":"human.ask"}),
                json!({"type":"tool-call","toolName":"file.write"})
            ])
            .is_some()
        );
        assert!(
            validate_tool_batch(&[
                json!({"type":"tool-call","toolName":"file.read"}),
                json!({"type":"tool-call","toolName":"file.read"})
            ])
            .is_none()
        );
    }

    #[test]
    fn monitored_commands_must_settle_and_be_delivered_before_final_answer() {
        let session = running();
        for task in [
            json!({"state":"assessment_required"}),
            json!({"state":"background"}),
            json!({"state":"settled"}),
        ] {
            assert!(matches!(final_answer(&session, &session,
                &json!({"metadata":{"commandTasks":[task]}}), "Done"), Decision::Correct(_)));
        }
        assert!(matches!(final_answer(&session, &session,
            &json!({"metadata":{"commandTasks":[{"state":"settled","deliveredStep":3}]}}), "Done"),
            Decision::Finish(_)));
    }
}
