use super::*;
use pretty_assertions::assert_eq;
use serde_json::json;

const NOW: &str = "2026-07-11T12:00:10.000Z";
const CREATED: &str = "2026-07-11T12:00:00.000Z";
const EXPIRES: &str = "2026-07-11T12:01:00.000Z";

fn surface() -> Surface {
    Surface {
        id: "moa-windows".into(),
        kind: "windows".into(),
        mode: "text".into(),
        device_id: Some("device-local-1".into()),
    }
}
fn proposal() -> Envelope {
    parse_envelope(&serde_json::to_vec(&json!({
        "version": 2, "type": "action.proposed", "message_id": "proposal-message-1",
        "session_id": "session-1", "surface": surface(), "timestamp": CREATED,
        "payload": { "proposal_id": "proposal-1", "kind": "open_url", "approval_class": "confirm",
          "expires_at": EXPIRES, "preconditions": {"foreground": "browser"},
          "params": {"url": "https://example.test"}, "proposed_by": "gateway", "session_id": "session-1" }
    })).unwrap()).unwrap()
}
fn context() -> LocalContext {
    LocalContext {
        session_id: "session-1".into(),
        surface: surface(),
        now: NOW.into(),
        state: BTreeMap::from([("foreground".into(), json!("browser"))]),
    }
}
fn approval(p: &Envelope) -> LocalApproval {
    approve_locally(
        p,
        "approval-message-1",
        "local-user",
        "2026-07-11T12:00:05.000Z",
    )
    .unwrap()
}

fn context_descriptor() -> ContextDescriptor {
    ContextDescriptor {
        version: 1,
        surface: "windows".into(),
        availability: ContextAvailability::Available,
        reason: None,
        captured_at: NOW.into(),
        freshness: ContextFreshness::Fresh,
        application: Some(ContextApplication {
            kind: "browser".into(),
            id: "Chrome.EXE".into(),
            origin: Some("https://mail.example.test".into()),
            document_id: Some("mail.example.test".into()),
            class_id: Some("Chrome_WidgetWin_1".into()),
        }),
        page: None,
        privacy: ContextPrivacy {
            page_content_included: false,
            window_title_included: false,
        },
    }
}

fn adapter() -> ExecutionAdapterDescriptor {
    ExecutionAdapterDescriptor {
        version: 1,
        adapter: "browser-session".into(),
        status: AdapterStatus::Available,
        unavailable_reason: None,
        credential_source: CredentialSource::ExistingBrowserSession,
        authentication_state: AuthenticationState::NotInspected,
        context_binding: Some(AdapterContextBinding {
            application_id: "chrome.exe".into(),
            document_id: Some("mail.example.test".into()),
            class_id: Some("Chrome_WidgetWin_1".into()),
        }),
        modes: vec![ExecutionMode::Read, ExecutionMode::Draft],
        constraints: vec![
            AdapterConstraint::LocalAllowlistValidation,
            AdapterConstraint::NoCookieExport,
            AdapterConstraint::NoProviderCredentials,
            AdapterConstraint::ProposalBeforeExecution,
        ],
    }
}

fn installed_package() -> InstalledWindowsPackage {
    InstalledWindowsPackage {
        package_id: "Moa.Windows".into(),
        version: WindowsPackageVersion {
            major: 1,
            minor: 2,
            build: 3,
            revision: 4,
        },
        architecture: WindowsArchitecture::X64,
        channel: UpdateChannel::Stable,
    }
}

fn update_metadata() -> WindowsUpdateMetadata {
    WindowsUpdateMetadata {
        package_id: "Moa.Windows".into(),
        version: WindowsPackageVersion {
            major: 1,
            minor: 3,
            build: 0,
            revision: 0,
        },
        architectures: vec![WindowsArchitecture::X64, WindowsArchitecture::Arm64],
        channel: UpdateChannel::Stable,
        mechanism: WindowsUpdateMechanism::MicrosoftStore {
            product_id: "9NMOAWINDOWS".into(),
        },
    }
}

#[test]
fn fresh_context_resolves_adapter_without_claiming_authentication() {
    let resolved = resolve_execution_adapters(
        &context_descriptor(),
        &[adapter()],
        CREATED,
        "2026-07-11T12:00:20.000Z",
    )
    .unwrap();
    assert_eq!(resolved.len(), 1);
    assert_eq!(resolved[0].adapter, "browser-session");
    assert_eq!(
        resolved[0].authentication_state,
        AuthenticationState::NotInspected
    );
    let wire = serde_json::to_string(&resolved).unwrap();
    assert!(wire.contains("\"authentication_state\":\"not_inspected\""));
    assert!(!wire.contains("Bearer "));
    assert!(!wire.contains("access_token"));
    assert!(!wire.contains("secret"));
}

#[test]
fn context_matching_fails_closed_for_stale_private_or_mismatched_evidence() {
    let cases = [
        {
            let mut value = context_descriptor();
            value.freshness = ContextFreshness::Stale;
            value
        },
        {
            let mut value = context_descriptor();
            value.privacy.window_title_included = true;
            value
        },
        {
            let mut value = context_descriptor();
            value.captured_at = "2026-07-11T12:00:30.000Z".into();
            value
        },
    ];
    for context in cases {
        assert_eq!(
            resolve_execution_adapters(&context, &[adapter()], CREATED, "2026-07-11T12:00:20.000Z")
                .unwrap_err(),
            SurfaceError::InvalidObservation
        );
    }

    let mut mismatched = adapter();
    mismatched.context_binding.as_mut().unwrap().class_id = Some("OtherWindow".into());
    assert!(
        resolve_execution_adapters(
            &context_descriptor(),
            &[mismatched],
            CREATED,
            "2026-07-11T12:00:20.000Z"
        )
        .unwrap()
        .is_empty()
    );
}

#[test]
fn adapter_advertisements_require_all_local_authority_constraints() {
    let mut missing_guard = adapter();
    missing_guard.constraints.pop();
    assert_eq!(
        resolve_execution_adapters(
            &context_descriptor(),
            &[missing_guard],
            CREATED,
            "2026-07-11T12:00:20.000Z"
        )
        .unwrap_err(),
        SurfaceError::InvalidCapabilityDescriptor
    );

    let mut unavailable = adapter();
    unavailable.status = AdapterStatus::Unavailable;
    unavailable.unavailable_reason = Some("browser_adapter_offline".into());
    assert!(
        resolve_execution_adapters(
            &context_descriptor(),
            &[unavailable],
            CREATED,
            "2026-07-11T12:00:20.000Z"
        )
        .unwrap()
        .is_empty()
    );
}

#[test]
fn standard_windows_update_metadata_is_eligible_without_installing() {
    assert_eq!(
        evaluate_windows_update(&installed_package(), &update_metadata()).unwrap(),
        UpdateEligibility::Eligible
    );
    let mut current = update_metadata();
    current.version = installed_package().version;
    assert_eq!(
        evaluate_windows_update(&installed_package(), &current).unwrap(),
        UpdateEligibility::AlreadyCurrent
    );
}

#[test]
fn update_eligibility_rejects_incompatible_or_bespoke_metadata() {
    let mut wrong_channel = update_metadata();
    wrong_channel.channel = UpdateChannel::Preview;
    assert_eq!(
        evaluate_windows_update(&installed_package(), &wrong_channel).unwrap(),
        UpdateEligibility::ChannelMismatch
    );

    for uri in [
        "http://updates.example.test/moa.appinstaller",
        "https://user@updates.example.test/moa.appinstaller",
        "https://updates.example.test/moa.exe",
        "https://updates.example.test/moa.appinstaller?token=secret",
    ] {
        let mut update = update_metadata();
        update.mechanism = WindowsUpdateMechanism::AppInstaller {
            manifest_uri: uri.into(),
        };
        assert_eq!(
            evaluate_windows_update(&installed_package(), &update).unwrap_err(),
            SurfaceError::InvalidUpdateMetadata
        );
    }

    let mut duplicate_architecture = update_metadata();
    duplicate_architecture.architectures = vec![WindowsArchitecture::X64; 2];
    assert_eq!(
        evaluate_windows_update(&installed_package(), &duplicate_architecture).unwrap_err(),
        SurfaceError::InvalidUpdateMetadata
    );
}

#[test]
fn valid_local_approval_produces_bound_receipt_without_execution() {
    let p = proposal();
    assert_eq!(
        proposal_digest(&p).unwrap(),
        "029f5888e5c03012c814bdd0dd419d0ca77d0711938ce4319828c27787b1f2ce"
    );
    let eligible = evaluate(p.clone(), Some(approval(&p)), &context()).unwrap();
    let receipt = eligible
        .receipt("receipt-1", Outcome::Executed, NOW)
        .unwrap();
    assert_eq!(receipt.proposal_message_id, "proposal-message-1");
    assert_eq!(
        receipt.approval_message_id.as_deref(),
        Some("approval-message-1")
    );
    assert_eq!(receipt.surface, surface());
}

#[test]
fn timestamp_validation_rejects_impossible_or_ambiguous_dates() {
    let mut value = serde_json::to_value(proposal()).unwrap();
    for timestamp in [
        "2026-99-99T99:99:99.999Z",
        "2026-02-29T00:00:00.000Z",
        "2026-07-11T12:00:00Z",
        "2026-07-11T12x00x00.000Z",
        "0000-01-01T00:00:00.000Z",
    ] {
        value["timestamp"] = json!(timestamp);
        assert_eq!(
            parse_envelope(&serde_json::to_vec(&value).unwrap()).unwrap_err(),
            SurfaceError::InvalidEnvelope
        );
    }
}

#[test]
fn unknown_semantic_types_and_preproposal_receipts_fail_closed() {
    let mut value = serde_json::to_value(proposal()).unwrap();
    value["type"] = json!("effect.execute");
    assert_eq!(
        parse_envelope(&serde_json::to_vec(&value).unwrap()).unwrap_err(),
        SurfaceError::InvalidEnvelope
    );

    let p = proposal();
    let eligible = evaluate(p.clone(), Some(approval(&p)), &context()).unwrap();
    assert_eq!(
        eligible
            .receipt("receipt-1", Outcome::Executed, "2026-07-11T11:59:59.000Z")
            .unwrap_err(),
        SurfaceError::InvalidEnvelope
    );
}

#[test]
fn malformed_proposal_and_approval_semantics_fail_closed() {
    for (field, value) in [
        ("kind", json!("run_shell")),
        ("approval_class", json!("sometimes")),
        ("proposal_id", json!("bad id")),
    ] {
        let mut p = proposal();
        p.payload[field] = value;
        assert_eq!(
            evaluate(p, None, &context()).unwrap_err(),
            SurfaceError::InvalidEnvelope
        );
    }
    let p = proposal();
    let mut a = approval(&p);
    a.envelope.payload["proposal_digest"] = json!("not-a-digest");
    assert_eq!(
        evaluate(p, Some(a), &context()).unwrap_err(),
        SurfaceError::InvalidEnvelope
    );
}

#[test]
fn benign_additive_fields_inside_surface_and_authority_payload_are_tolerated() {
    let mut value = serde_json::to_value(proposal()).unwrap();
    value["surface"]["theme"] = json!("purple");
    value["payload"]["display_hint"] = json!("review carefully");
    let parsed = parse_envelope(&serde_json::to_vec(&value).unwrap()).unwrap();
    let approval = approval(&parsed);
    assert!(evaluate(parsed, Some(approval), &context()).is_ok());
}

#[test]
fn canonical_numbers_match_gateway_javascript_rendering() {
    let mut value = serde_json::to_value(proposal()).unwrap();
    value["payload"]["params"] = json!({"integer_float": 1.0, "small": 0.000001, "large": 1e21});
    let parsed = parse_envelope(&serde_json::to_vec(&value).unwrap()).unwrap();
    assert_eq!(
        proposal_digest(&parsed).unwrap(),
        "2cd893dc944b6f5a675637e72af11cc0a89b0fc6d0253309cf6361b95549e092"
    );
}

#[test]
fn missing_approval_fails_closed() {
    assert_eq!(
        evaluate(proposal(), None, &context()).unwrap_err(),
        SurfaceError::ApprovalRequired
    );
}

#[test]
fn complete_surface_is_authority() {
    for mutate in ["kind", "mode", "device"] {
        let mut ctx = context();
        match mutate {
            "kind" => ctx.surface.kind = "browser".into(),
            "mode" => ctx.surface.mode = "voice".into(),
            _ => ctx.surface.device_id = None,
        }
        assert_eq!(
            evaluate(proposal(), None, &ctx).unwrap_err(),
            SurfaceError::ScopeMismatch
        );
    }
}

#[test]
fn proposal_mutation_breaks_approval_digest() {
    let original = proposal();
    let approved = approval(&original);
    let mut changed = original;
    changed.payload["params"]["url"] = json!("https://attacker.test");
    assert_eq!(
        evaluate(changed, Some(approved), &context()).unwrap_err(),
        SurfaceError::ApprovalMismatch
    );
}

#[test]
fn stale_and_expired_proposals_fail_closed() {
    let mut ctx = context();
    ctx.state.insert("foreground".into(), json!("terminal"));
    assert_eq!(
        evaluate(proposal(), None, &ctx).unwrap_err(),
        SurfaceError::StaleState
    );
    let mut ctx = context();
    ctx.now = EXPIRES.into();
    assert_eq!(
        evaluate(proposal(), None, &ctx).unwrap_err(),
        SurfaceError::Expired
    );
}

#[test]
fn additive_benign_data_is_ignored_but_authority_is_rejected() {
    let benign = serde_json::to_vec(&json!({"version": 2, "type": "turn.text", "message_id":"m", "session_id":"s", "surface":surface(), "timestamp":CREATED, "payload":{"text":"hello"}, "theme":"purple"})).unwrap();
    assert!(parse_envelope(&benign).is_ok());
    for key in [
        "token",
        "oauth_token",
        "provider-secret",
        "privateKey",
        "authorization",
        "token_value",
        "authorization_hint",
        "client_secret_material",
    ] {
        let mut value: Value = serde_json::from_slice(&benign).unwrap();
        value[key] = json!("secret-value");
        assert_eq!(
            parse_envelope(&serde_json::to_vec(&value).unwrap()).unwrap_err(),
            SurfaceError::CredentialData
        );
    }
}

#[test]
fn credential_values_and_executable_fields_are_rejected_recursively() {
    let base = json!({"version":2,"type":"turn.text","message_id":"m","session_id":"s","surface":surface(),"timestamp":CREATED,"payload":{"text":"hello"}});
    for dangerous in [
        json!({"nested":{"shell":"whoami"}}),
        json!({"note":"Bearer abcdefghijklmnop"}),
        json!({"url":"https://x.test/cb?code=abcdefgh"}),
    ] {
        let mut value = base.clone();
        value["future"] = dangerous;
        assert!(matches!(
            parse_envelope(&serde_json::to_vec(&value).unwrap()),
            Err(SurfaceError::ExecutableData | SurfaceError::CredentialData)
        ));
    }
}

#[test]
fn n_and_n_minus_one_are_accepted_and_other_versions_rejected() {
    let mut value = serde_json::to_value(proposal()).unwrap();
    for version in [CURRENT_VERSION, PREVIOUS_VERSION] {
        value["version"] = json!(version);
        assert!(parse_envelope(&serde_json::to_vec(&value).unwrap()).is_ok());
    }
    value["version"] = json!(3);
    assert_eq!(
        parse_envelope(&serde_json::to_vec(&value).unwrap()).unwrap_err(),
        SurfaceError::UnsupportedVersion
    );
}

#[test]
fn size_and_collection_bounds_are_enforced_before_authority() {
    assert_eq!(
        parse_envelope(&vec![b' '; MAX_ENVELOPE_BYTES + 1]).unwrap_err(),
        SurfaceError::TooLarge
    );
    let mut value = serde_json::to_value(proposal()).unwrap();
    value["future"] = Value::Array((0..65).map(|_| json!(1)).collect());
    assert_eq!(
        parse_envelope(&serde_json::to_vec(&value).unwrap()).unwrap_err(),
        SurfaceError::InvalidEnvelope
    );
}

#[test]
fn public_in_memory_envelopes_cannot_bypass_parse_security() {
    let mut p = proposal();
    p.version = 99;
    assert_eq!(
        evaluate(p, None, &context()).unwrap_err(),
        SurfaceError::UnsupportedVersion
    );
    let mut p = proposal();
    p.additive.insert("oauth_token".into(), json!("secret"));
    assert_eq!(
        evaluate(p, None, &context()).unwrap_err(),
        SurfaceError::CredentialData
    );
}
