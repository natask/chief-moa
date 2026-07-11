//! Provider-neutral local authority core for a future Moa Windows surface.
//! This crate evaluates data; it never executes an action.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use thiserror::Error;

pub const CURRENT_VERSION: u8 = 2;
pub const PREVIOUS_VERSION: u8 = 1;
pub const MAX_ENVELOPE_BYTES: usize = 64 * 1024;
pub const MAX_NESTING: usize = 12;
pub const MAX_FIELDS: usize = 64;
pub const MAX_ITEMS: usize = 64;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum SurfaceError {
    #[error("envelope exceeds the 64 KiB bound")]
    TooLarge,
    #[error("unsupported protocol version")]
    UnsupportedVersion,
    #[error("unsupported or malformed envelope")]
    InvalidEnvelope,
    #[error("credential-shaped data is forbidden")]
    CredentialData,
    #[error("executable-shaped data is forbidden")]
    ExecutableData,
    #[error("proposal does not belong to this session or complete surface")]
    ScopeMismatch,
    #[error("proposal has expired")]
    Expired,
    #[error("local state no longer satisfies the proposal")]
    StaleState,
    #[error("explicit local approval is required")]
    ApprovalRequired,
    #[error("approval is not bound to this proposal")]
    ApprovalMismatch,
    #[error("approval time is invalid")]
    ApprovalTimeInvalid,
    #[error("a receipt requires a previously eligible proposal")]
    NotEligible,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Surface {
    pub id: String,
    pub kind: String,
    pub mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Envelope {
    pub version: u8,
    #[serde(rename = "type")]
    pub kind: String,
    pub message_id: String,
    pub session_id: String,
    pub surface: Surface,
    pub timestamp: String,
    #[serde(default)]
    pub reply_to: Option<String>,
    pub payload: Value,
    #[serde(flatten)]
    pub additive: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Proposal {
    pub proposal_id: String,
    pub kind: String,
    pub approval_class: String,
    pub expires_at: String,
    pub preconditions: BTreeMap<String, Value>,
    #[serde(default)]
    pub params: BTreeMap<String, Value>,
    #[serde(default = "gateway")]
    pub proposed_by: String,
    pub session_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Approval {
    pub proposal_id: String,
    pub proposal_message_id: String,
    pub proposal_digest: String,
    pub decision: String,
    pub actor_id: String,
    pub decided_at: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LocalContext {
    pub session_id: String,
    pub surface: Surface,
    pub now: String,
    pub state: BTreeMap<String, Value>,
}

#[derive(Clone, Debug)]
pub struct EligibleProposal {
    envelope: Envelope,
    proposal: Proposal,
    approval_message_id: Option<String>,
}

/// Opaque evidence minted only by the local surface process after its UI has
/// obtained a user decision. Deserialized wire data cannot construct it.
#[derive(Clone, Debug)]
pub struct LocalApproval {
    envelope: Envelope,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct LocalReceipt {
    pub receipt_id: String,
    pub proposal_id: String,
    pub proposal_message_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approval_message_id: Option<String>,
    pub outcome: Outcome,
    pub observed_at: String,
    pub session_id: String,
    pub surface: Surface,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Executed,
    Rejected,
    Failed,
    Canceled,
}

pub fn parse_envelope(bytes: &[u8]) -> Result<Envelope, SurfaceError> {
    if bytes.len() > MAX_ENVELOPE_BYTES {
        return Err(SurfaceError::TooLarge);
    }
    let value: Value = serde_json::from_slice(bytes).map_err(|_| SurfaceError::InvalidEnvelope)?;
    scan_safe(&value, 0)?;
    let envelope: Envelope =
        serde_json::from_value(value).map_err(|_| SurfaceError::InvalidEnvelope)?;
    validate_envelope_shape(&envelope)?;
    Ok(envelope)
}

pub fn evaluate(
    proposal_envelope: Envelope,
    local_approval: Option<LocalApproval>,
    context: &LocalContext,
) -> Result<EligibleProposal, SurfaceError> {
    validate_in_memory_envelope(&proposal_envelope)?;
    if proposal_envelope.kind != "action.proposed" {
        return Err(SurfaceError::InvalidEnvelope);
    }
    if proposal_envelope.session_id != context.session_id
        || proposal_envelope.surface != context.surface
    {
        return Err(SurfaceError::ScopeMismatch);
    }
    let proposal: Proposal = serde_json::from_value(proposal_envelope.payload.clone())
        .map_err(|_| SurfaceError::InvalidEnvelope)?;
    validate_proposal(&proposal)?;
    if proposal.session_id != proposal_envelope.session_id || proposal.preconditions.is_empty() {
        return Err(SurfaceError::InvalidEnvelope);
    }
    if parse_time(&proposal.expires_at)? <= parse_time(&context.now)? {
        return Err(SurfaceError::Expired);
    }
    if !proposal
        .preconditions
        .iter()
        .all(|(key, expected)| context.state.get(key) == Some(expected))
    {
        return Err(SurfaceError::StaleState);
    }
    let approval_message_id = if proposal.approval_class == "none" {
        None
    } else {
        let local_approval = local_approval.ok_or(SurfaceError::ApprovalRequired)?;
        validate_approval(
            &proposal_envelope,
            &proposal,
            &local_approval.envelope,
            context,
        )?;
        Some(local_approval.envelope.message_id)
    };
    Ok(EligibleProposal {
        envelope: proposal_envelope,
        proposal,
        approval_message_id,
    })
}

/// Mints local approval evidence. A future Windows UI must call this only from
/// an explicit local approval gesture; remote envelopes are never accepted as
/// this capability.
pub fn approve_locally(
    proposal_envelope: &Envelope,
    approval_message_id: &str,
    actor_id: &str,
    decided_at: &str,
) -> Result<LocalApproval, SurfaceError> {
    validate_in_memory_envelope(proposal_envelope)?;
    require_id(approval_message_id)?;
    require_id(actor_id)?;
    parse_time(decided_at)?;
    let proposal: Proposal = serde_json::from_value(proposal_envelope.payload.clone())
        .map_err(|_| SurfaceError::InvalidEnvelope)?;
    validate_proposal(&proposal)?;
    if proposal_envelope.kind != "action.proposed"
        || parse_time(decided_at)? < parse_time(&proposal_envelope.timestamp)?
        || parse_time(decided_at)? >= parse_time(&proposal.expires_at)?
    {
        return Err(SurfaceError::ApprovalTimeInvalid);
    }
    let payload = Approval {
        proposal_id: proposal.proposal_id,
        proposal_message_id: proposal_envelope.message_id.clone(),
        proposal_digest: proposal_digest(proposal_envelope)?,
        decision: "approved".into(),
        actor_id: actor_id.into(),
        decided_at: decided_at.into(),
    };
    Ok(LocalApproval {
        envelope: Envelope {
            version: proposal_envelope.version,
            kind: "action.approved".into(),
            message_id: approval_message_id.into(),
            session_id: proposal_envelope.session_id.clone(),
            surface: proposal_envelope.surface.clone(),
            timestamp: decided_at.into(),
            reply_to: Some(proposal_envelope.message_id.clone()),
            payload: serde_json::to_value(payload).map_err(|_| SurfaceError::InvalidEnvelope)?,
            additive: BTreeMap::new(),
        },
    })
}

impl EligibleProposal {
    /// Creates evidence after an external, platform-owned executor reports an
    /// observation. This method cannot perform the effect.
    pub fn receipt(
        self,
        receipt_id: &str,
        outcome: Outcome,
        observed_at: &str,
    ) -> Result<LocalReceipt, SurfaceError> {
        require_id(receipt_id)?;
        if parse_time(observed_at)? < parse_time(&self.envelope.timestamp)? {
            return Err(SurfaceError::InvalidEnvelope);
        }
        Ok(LocalReceipt {
            receipt_id: receipt_id.into(),
            proposal_id: self.proposal.proposal_id,
            proposal_message_id: self.envelope.message_id,
            approval_message_id: self.approval_message_id,
            outcome,
            observed_at: observed_at.into(),
            session_id: self.envelope.session_id,
            surface: self.envelope.surface,
        })
    }
}

pub fn proposal_digest(envelope: &Envelope) -> Result<String, SurfaceError> {
    let payload = if envelope.kind == "action.proposed" {
        let proposal: Proposal = serde_json::from_value(envelope.payload.clone())
            .map_err(|_| SurfaceError::InvalidEnvelope)?;
        serde_json::to_value(proposal).map_err(|_| SurfaceError::InvalidEnvelope)?
    } else {
        envelope.payload.clone()
    };
    let canonical = serde_json::json!({
        "version": envelope.version, "message_id": envelope.message_id,
        "session_id": envelope.session_id, "surface": envelope.surface,
        "timestamp": envelope.timestamp, "payload": payload,
    });
    let bytes = canonical_json(&canonical).into_bytes();
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn validate_approval(
    proposal_envelope: &Envelope,
    proposal: &Proposal,
    approval_envelope: &Envelope,
    context: &LocalContext,
) -> Result<(), SurfaceError> {
    if approval_envelope.kind != "action.approved"
        || approval_envelope.version != proposal_envelope.version
        || approval_envelope.session_id != proposal_envelope.session_id
        || approval_envelope.surface != proposal_envelope.surface
        || approval_envelope.reply_to.as_deref() != Some(&proposal_envelope.message_id)
    {
        return Err(SurfaceError::ApprovalMismatch);
    }
    let approval: Approval = serde_json::from_value(approval_envelope.payload.clone())
        .map_err(|_| SurfaceError::InvalidEnvelope)?;
    require_id(&approval.proposal_id)?;
    require_id(&approval.proposal_message_id)?;
    require_id(&approval.actor_id)?;
    if approval.proposal_digest.len() != 64
        || !approval
            .proposal_digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(SurfaceError::InvalidEnvelope);
    }
    if approval.decision != "approved"
        || approval.proposal_id != proposal.proposal_id
        || approval.proposal_message_id != proposal_envelope.message_id
        || approval.proposal_digest != proposal_digest(proposal_envelope)?
    {
        return Err(SurfaceError::ApprovalMismatch);
    }
    let decided = parse_time(&approval.decided_at)?;
    if decided < parse_time(&proposal_envelope.timestamp)? || decided > parse_time(&context.now)? {
        return Err(SurfaceError::ApprovalTimeInvalid);
    }
    Ok(())
}

fn validate_proposal(proposal: &Proposal) -> Result<(), SurfaceError> {
    require_id(&proposal.proposal_id)?;
    require_id(&proposal.proposed_by)?;
    require_id(&proposal.session_id)?;
    if ![
        "open_url",
        "open_app",
        "dial",
        "browser_task",
        "page_tweak",
        "file_export",
    ]
    .contains(&proposal.kind.as_str())
        || !["none", "confirm", "sensitive"].contains(&proposal.approval_class.as_str())
        || proposal.preconditions.is_empty()
    {
        return Err(SurfaceError::InvalidEnvelope);
    }
    parse_time(&proposal.expires_at)?;
    Ok(())
}

fn validate_envelope_shape(envelope: &Envelope) -> Result<(), SurfaceError> {
    if !matches!(envelope.version, CURRENT_VERSION | PREVIOUS_VERSION) {
        return Err(SurfaceError::UnsupportedVersion);
    }
    const TYPES: &[&str] = &[
        "hello",
        "hello.accepted",
        "resume",
        "turn.text",
        "turn.voice.started",
        "turn.voice.completed",
        "route.selected",
        "run.queued",
        "run.running",
        "run.needs_approval",
        "run.completed",
        "run.failed",
        "artifact.created",
        "message.created",
        "action.proposed",
        "action.approved",
        "action.receipted",
        "session.snapshot_required",
    ];
    if !TYPES.contains(&envelope.kind.as_str()) {
        return Err(SurfaceError::InvalidEnvelope);
    }
    require_id(&envelope.message_id)?;
    require_id(&envelope.session_id)?;
    validate_surface(&envelope.surface)?;
    parse_time(&envelope.timestamp)?;
    if let Some(reply) = &envelope.reply_to {
        require_id(reply)?;
    }
    Ok(())
}

fn validate_in_memory_envelope(envelope: &Envelope) -> Result<(), SurfaceError> {
    let value = serde_json::to_value(envelope).map_err(|_| SurfaceError::InvalidEnvelope)?;
    let bytes = serde_json::to_vec(&value).map_err(|_| SurfaceError::InvalidEnvelope)?;
    if bytes.len() > MAX_ENVELOPE_BYTES {
        return Err(SurfaceError::TooLarge);
    }
    scan_safe(&value, 0)?;
    validate_envelope_shape(envelope)
}

fn validate_surface(surface: &Surface) -> Result<(), SurfaceError> {
    require_id(&surface.id)?;
    if surface.kind != "windows"
        || !matches!(
            surface.mode.as_str(),
            "text" | "voice" | "live_voice" | "event"
        )
    {
        return Err(SurfaceError::ScopeMismatch);
    }
    if let Some(device) = &surface.device_id {
        require_id(device)?;
    }
    Ok(())
}

fn scan_safe(value: &Value, depth: usize) -> Result<(), SurfaceError> {
    if depth > MAX_NESTING {
        return Err(SurfaceError::InvalidEnvelope);
    }
    match value {
        Value::Array(items) => {
            if items.len() > MAX_ITEMS {
                return Err(SurfaceError::InvalidEnvelope);
            }
            for item in items {
                scan_safe(item, depth + 1)?;
            }
        }
        Value::Object(fields) => {
            if fields.len() > MAX_FIELDS {
                return Err(SurfaceError::InvalidEnvelope);
            }
            for (key, item) in fields {
                let compact: String = key
                    .to_ascii_lowercase()
                    .chars()
                    .filter(|c| c.is_ascii_alphanumeric())
                    .collect();
                if ["script", "javascript", "shell", "command", "css", "code"]
                    .contains(&compact.as_str())
                {
                    return Err(SurfaceError::ExecutableData);
                }
                if [
                    "token",
                    "privatekey",
                    "apikey",
                    "clientsecret",
                    "providersecret",
                    "providerkey",
                    "authorization",
                    "password",
                ]
                .iter()
                .any(|family| compact.contains(family))
                {
                    return Err(SurfaceError::CredentialData);
                }
                scan_safe(item, depth + 1)?;
            }
        }
        Value::String(text) => {
            let lower = text.to_ascii_lowercase();
            if lower.contains("bearer ")
                || lower.contains("?code=")
                || lower.contains("&code=")
                || lower.contains("access_token=")
                || lower.starts_with("sk-")
                || lower.starts_with("github_pat_")
            {
                return Err(SurfaceError::CredentialData);
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
    Ok(())
}

fn canonical_json(value: &Value) -> String {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<_> = map.keys().collect();
            keys.sort();
            let parts: Vec<_> = keys
                .iter()
                .map(|key| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap_or_default(),
                        canonical_json(&map[*key])
                    )
                })
                .collect();
            format!("{{{}}}", parts.join(","))
        }
        Value::Array(items) => format!(
            "[{}]",
            items
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Number(number) => {
            if let Some(value) = number.as_i64() {
                value.to_string()
            } else if let Some(value) = number.as_u64() {
                value.to_string()
            } else {
                ryu_js::Buffer::new()
                    .format(number.as_f64().unwrap_or_default())
                    .to_owned()
            }
        }
        _ => serde_json::to_string(value).unwrap_or_default(),
    }
}

fn require_id(value: &str) -> Result<(), SurfaceError> {
    if value.is_empty()
        || value.len() > 160
        || !value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._:-".contains(&c))
    {
        return Err(SurfaceError::InvalidEnvelope);
    }
    Ok(())
}

// ISO-8601 UTC timestamps sort lexicographically after normalization. Requiring
// the exact fixed-width shape avoids locale/parser ambiguity in the core.
fn parse_time(value: &str) -> Result<&str, SurfaceError> {
    if value.len() != 24
        || !value.ends_with('Z')
        || value.as_bytes().get(4) != Some(&b'-')
        || value.as_bytes().get(7) != Some(&b'-')
        || value.as_bytes().get(10) != Some(&b'T')
        || value.as_bytes().get(13) != Some(&b':')
        || value.as_bytes().get(16) != Some(&b':')
        || value.as_bytes().get(19) != Some(&b'.')
        || value.as_bytes().get(23) != Some(&b'Z')
    {
        return Err(SurfaceError::InvalidEnvelope);
    }
    let digits =
        |range: std::ops::Range<usize>| value.get(range).and_then(|part| part.parse::<u32>().ok());
    let (year, month, day, hour, minute, second, millis) = (
        digits(0..4),
        digits(5..7),
        digits(8..10),
        digits(11..13),
        digits(14..16),
        digits(17..19),
        digits(20..23),
    );
    let (Some(year), Some(month), Some(day), Some(hour), Some(minute), Some(second), Some(millis)) =
        (year, month, day, hour, minute, second, millis)
    else {
        return Err(SurfaceError::InvalidEnvelope);
    };
    let leap = year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400));
    let max_day = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => 0,
    };
    if year == 0
        || day == 0
        || day > max_day
        || hour > 23
        || minute > 59
        || second > 59
        || millis > 999
    {
        return Err(SurfaceError::InvalidEnvelope);
    }
    Ok(value)
}

fn gateway() -> String {
    "gateway".into()
}

#[cfg(test)]
mod tests;
