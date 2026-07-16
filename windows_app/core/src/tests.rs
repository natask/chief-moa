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

#[test]
fn context_descriptor_validation_covers_each_bounded_field() {
    let assert_invalid = |candidate: ContextDescriptor| {
        assert_eq!(
            validate_context_descriptor(&candidate, CREATED, NOW),
            Err(SurfaceError::InvalidObservation)
        );
    };

    let mut candidate = context_descriptor();
    candidate.version = 2;
    assert_invalid(candidate);
    let mut candidate = context_descriptor();
    candidate.surface = "macos".into();
    assert_invalid(candidate);
    let mut candidate = context_descriptor();
    candidate.availability = ContextAvailability::Unavailable;
    assert_invalid(candidate);
    let mut candidate = context_descriptor();
    candidate.reason = Some("permission_denied".into());
    assert_invalid(candidate);
    let mut candidate = context_descriptor();
    candidate.freshness = ContextFreshness::Stale;
    assert_invalid(candidate);
    let mut candidate = context_descriptor();
    candidate.application = None;
    assert_invalid(candidate);
    let mut candidate = context_descriptor();
    candidate.privacy.window_title_included = true;
    assert_invalid(candidate);

    for kind in ["unknown", ""] {
        let mut candidate = context_descriptor();
        candidate.application.as_mut().unwrap().kind = kind.into();
        assert_invalid(candidate);
    }
    for application_id in ["", &"a".repeat(201), "bad/app"] {
        let mut candidate = context_descriptor();
        candidate.application.as_mut().unwrap().id = application_id.into();
        assert_invalid(candidate);
    }
    for origin in [
        "http://example.test",
        "https://user@example.test",
        "https://example.test/path?q=1",
        "https://example.test/path#fragment",
        &format!("https://{}", "a".repeat(505)),
    ] {
        let mut candidate = context_descriptor();
        candidate.application.as_mut().unwrap().origin = Some(origin.into());
        assert_invalid(candidate);
    }
    for field in ["document", "class"] {
        let mut candidate = context_descriptor();
        if field == "document" {
            candidate.application.as_mut().unwrap().document_id = Some("bad/value".into());
        } else {
            candidate.application.as_mut().unwrap().class_id = Some("bad/value".into());
        }
        assert_invalid(candidate);
    }
    let mut candidate = context_descriptor();
    candidate.page = Some(ContextPage {
        title: None,
        location_scope: "bad/value".into(),
    });
    assert_invalid(candidate);
    let mut candidate = context_descriptor();
    candidate.page = Some(ContextPage {
        title: Some("Bearer secret".into()),
        location_scope: "inbox".into(),
    });
    assert_invalid(candidate);

    assert_invalid(context_descriptor_with_time("not-a-time"));
    assert_eq!(
        validate_context_descriptor(&context_descriptor(), "not-a-time", NOW),
        Err(SurfaceError::InvalidObservation)
    );
    assert_eq!(
        validate_context_descriptor(&context_descriptor(), CREATED, "not-a-time"),
        Err(SurfaceError::InvalidObservation)
    );
    assert_eq!(
        validate_context_descriptor(&context_descriptor(), NOW, CREATED),
        Err(SurfaceError::InvalidObservation)
    );
    assert_eq!(
        validate_context_descriptor(&context_descriptor_with_time(CREATED), NOW, NOW),
        Err(SurfaceError::InvalidObservation)
    );
    assert_eq!(
        validate_context_descriptor(
            &context_descriptor_with_time("2026-07-11T12:00:11.000Z"),
            CREATED,
            NOW,
        ),
        Err(SurfaceError::InvalidObservation)
    );
}

fn context_descriptor_with_time(captured_at: &str) -> ContextDescriptor {
    let mut value = context_descriptor();
    value.captured_at = captured_at.into();
    value
}

#[test]
fn adapter_validation_and_matching_cover_each_guard() {
    let assert_invalid = |candidate: ExecutionAdapterDescriptor| {
        assert_eq!(
            validate_execution_adapter(&candidate),
            Err(SurfaceError::InvalidCapabilityDescriptor)
        );
    };

    let mut candidate = adapter();
    candidate.version = 2;
    assert_invalid(candidate);
    let mut candidate = adapter();
    candidate.adapter.clear();
    assert_invalid(candidate);
    let mut candidate = adapter();
    candidate.modes.clear();
    assert_invalid(candidate);
    let mut candidate = adapter();
    candidate.modes = vec![ExecutionMode::Read; 4];
    assert_invalid(candidate);
    let mut candidate = adapter();
    candidate.constraints.pop();
    assert_invalid(candidate);
    let mut candidate = adapter();
    candidate.unavailable_reason = Some("unexpected".into());
    assert_invalid(candidate);
    let mut candidate = adapter();
    candidate.status = AdapterStatus::Unavailable;
    assert_invalid(candidate);
    let mut candidate = adapter();
    candidate.status = AdapterStatus::Unavailable;
    candidate.unavailable_reason = Some("bad reason".into());
    assert_invalid(candidate);
    let mut candidate = adapter();
    candidate.context_binding.as_mut().unwrap().application_id = "bad/app".into();
    assert_invalid(candidate);
    let mut candidate = adapter();
    candidate.context_binding.as_mut().unwrap().document_id = Some("bad/value".into());
    assert_invalid(candidate);
    let mut candidate = adapter();
    candidate.context_binding.as_mut().unwrap().class_id = Some("bad/value".into());
    assert_invalid(candidate);
    let mut candidate = adapter();
    candidate.constraints[0] = AdapterConstraint::NoCookieExport;
    assert_invalid(candidate);
    let mut candidate = adapter();
    candidate.modes = vec![ExecutionMode::Read, ExecutionMode::Read];
    assert_invalid(candidate);

    assert_eq!(
        resolve_execution_adapters(
            &context_descriptor(),
            &vec![adapter(); MAX_CAPABILITY_DESCRIPTORS + 1],
            CREATED,
            NOW,
        ),
        Err(SurfaceError::InvalidCapabilityDescriptor)
    );

    let mut unavailable = adapter();
    unavailable.status = AdapterStatus::Unavailable;
    unavailable.unavailable_reason = Some("signed_out".into());
    let mut wrong_application = adapter();
    wrong_application
        .context_binding
        .as_mut()
        .unwrap()
        .application_id = "other.exe".into();
    let mut wrong_document = adapter();
    wrong_document.context_binding.as_mut().unwrap().document_id = Some("other".into());
    let mut wrong_class = adapter();
    wrong_class.context_binding.as_mut().unwrap().class_id = Some("other".into());
    let mut unbound = adapter();
    unbound.context_binding = None;
    let resolved = resolve_execution_adapters(
        &context_descriptor(),
        &[
            unavailable,
            wrong_application,
            wrong_document,
            wrong_class,
            unbound,
        ],
        CREATED,
        NOW,
    )
    .unwrap();
    assert!(resolved.is_empty());
}

#[test]
fn update_validation_covers_standard_handoff_boundaries() {
    let installed = installed_package();
    let mut candidate = update_metadata();
    candidate.package_id = "Other.Package".into();
    assert_eq!(
        evaluate_windows_update(&installed, &candidate),
        Ok(UpdateEligibility::PackageMismatch)
    );
    let mut candidate = update_metadata();
    candidate.architectures = vec![WindowsArchitecture::Arm64];
    assert_eq!(
        evaluate_windows_update(&installed, &candidate),
        Ok(UpdateEligibility::ArchitectureMismatch)
    );
    let mut invalid_installed = installed_package();
    invalid_installed.package_id.clear();
    assert_eq!(
        evaluate_windows_update(&invalid_installed, &update_metadata()),
        Err(SurfaceError::InvalidUpdateMetadata)
    );

    let assert_invalid = |candidate: WindowsUpdateMetadata| {
        assert_eq!(
            validate_update_metadata(&candidate),
            Err(SurfaceError::InvalidUpdateMetadata)
        );
    };
    let mut candidate = update_metadata();
    candidate.package_id.clear();
    assert_invalid(candidate);
    let mut candidate = update_metadata();
    candidate.version = WindowsPackageVersion {
        major: 0,
        minor: 0,
        build: 0,
        revision: 0,
    };
    assert_invalid(candidate);
    let mut candidate = update_metadata();
    candidate.architectures.clear();
    assert_invalid(candidate);
    let mut candidate = update_metadata();
    candidate.architectures = vec![
        WindowsArchitecture::X64,
        WindowsArchitecture::Arm64,
        WindowsArchitecture::X64,
    ];
    assert_invalid(candidate);
    let mut candidate = update_metadata();
    candidate.architectures = vec![WindowsArchitecture::X64, WindowsArchitecture::X64];
    assert_invalid(candidate);
    let mut candidate = update_metadata();
    candidate.mechanism = WindowsUpdateMechanism::MicrosoftStore {
        product_id: String::new(),
    };
    assert_invalid(candidate);

    for uri in [
        "http://example.test/moa.appinstaller".to_string(),
        "https://example.test".to_string(),
        "https:///moa.appinstaller".to_string(),
        "https://user@example.test/moa.appinstaller".to_string(),
        "https://example.test/moa.appinstaller?q=1".to_string(),
        "https://example.test/moa.appinstaller#fragment".to_string(),
        "https://example.test/moa.msix".to_string(),
        "https://example.test/moa appinstaller".to_string(),
        "https://example.test/möa.appinstaller".to_string(),
        format!("https://example.test/{}.appinstaller", "a".repeat(2048)),
    ] {
        assert_eq!(
            validate_appinstaller_uri(&uri),
            Err(SurfaceError::InvalidUpdateMetadata)
        );
    }
    assert_eq!(
        validate_appinstaller_uri("https://example.test/moa.APPINSTALLER"),
        Ok(())
    );
}

#[test]
fn primitive_validators_cover_all_rejection_reasons() {
    for value in ["", &"a".repeat(161), "bad/value"] {
        assert_eq!(require_id(value), Err(SurfaceError::InvalidEnvelope));
    }
    assert_eq!(require_id("good.id:_-1"), Ok(()));
    for value in ["", &"a".repeat(201), "bad/value"] {
        assert_eq!(
            require_application_id(value),
            Err(SurfaceError::InvalidObservation)
        );
    }
    assert_eq!(require_application_id("good.app!"), Ok(()));
    for value in ["", &"a".repeat(241), "bad/value"] {
        assert_eq!(
            require_context_identity(value),
            Err(SurfaceError::InvalidObservation)
        );
    }
    assert_eq!(require_context_identity("good@app!"), Ok(()));
    for value in ["", &"a".repeat(121), "bad\nname", "Bearer secret"] {
        assert_eq!(
            require_display_name(value),
            Err(SurfaceError::InvalidCapabilityDescriptor)
        );
    }
    assert_eq!(require_display_name("Inbox"), Ok(()));
}

#[test]
fn timestamp_validation_covers_shape_digits_calendar_and_clock() {
    for invalid in [
        "2026-07-11T12:00:10.000",
        "2026/07-11T12:00:10.000Z",
        "2026-07/11T12:00:10.000Z",
        "2026-07-11 12:00:10.000Z",
        "2026-07-11T12-00:10.000Z",
        "2026-07-11T12:00-10.000Z",
        "2026-07-11T12:00:10,000Z",
        "xxxx-07-11T12:00:10.000Z",
        "0000-07-11T12:00:10.000Z",
        "2026-00-11T12:00:10.000Z",
        "2026-02-29T12:00:10.000Z",
        "2024-02-30T12:00:10.000Z",
        "2026-04-31T12:00:10.000Z",
        "2026-07-00T12:00:10.000Z",
        "2026-07-11T24:00:10.000Z",
        "2026-07-11T12:60:10.000Z",
        "2026-07-11T12:00:60.000Z",
    ] {
        assert_eq!(
            parse_time(invalid),
            Err(SurfaceError::InvalidEnvelope),
            "{invalid}"
        );
    }
    for valid in [
        "2024-02-29T23:59:59.999Z",
        "2000-02-29T00:00:00.000Z",
        "1900-02-28T00:00:00.000Z",
        "2026-04-30T00:00:00.000Z",
        "2026-12-31T00:00:00.000Z",
    ] {
        assert_eq!(parse_time(valid), Ok(valid));
    }
}

#[test]
fn security_scanner_and_canonical_json_cover_every_value_family() {
    for key in ["script", "javascript", "shell", "command", "css", "code"] {
        assert_eq!(
            scan_safe(&json!({key: "x"}), 0),
            Err(SurfaceError::ExecutableData)
        );
    }
    for key in [
        "token",
        "private_key",
        "api-key",
        "client_secret",
        "provider_secret",
        "provider_key",
        "authorization",
        "password",
    ] {
        assert_eq!(
            scan_safe(&json!({key: "x"}), 0),
            Err(SurfaceError::CredentialData)
        );
    }
    for value in [
        "Bearer secret",
        "callback?code=x",
        "callback&code=x",
        "access_token=x",
        "sk-secret",
        "github_pat_secret",
    ] {
        assert_eq!(
            scan_safe(&json!(value), 0),
            Err(SurfaceError::CredentialData)
        );
    }
    assert_eq!(scan_safe(&json!([null, true, 1, "safe"]), 0), Ok(()));
    assert_eq!(
        scan_safe(&Value::Array(vec![Value::Null; MAX_ITEMS + 1]), 0),
        Err(SurfaceError::InvalidEnvelope)
    );
    let wide = (0..=MAX_FIELDS)
        .map(|index| (format!("field{index}"), Value::Null))
        .collect();
    assert_eq!(
        scan_safe(&Value::Object(wide), 0),
        Err(SurfaceError::InvalidEnvelope)
    );
    assert_eq!(
        scan_safe(&Value::Null, MAX_NESTING + 1),
        Err(SurfaceError::InvalidEnvelope)
    );

    assert_eq!(
        canonical_json(&json!({"b": 2, "a": [true, null]})),
        r#"{"a":[true,null],"b":2}"#
    );
    assert_eq!(canonical_json(&json!(u64::MAX)), u64::MAX.to_string());
    assert_eq!(canonical_json(&json!(1.25)), "1.25");
    assert_eq!(canonical_json(&json!("text")), "\"text\"");
}

#[test]
fn proposal_evaluation_covers_no_approval_and_time_guards() {
    let mut no_approval = proposal();
    no_approval.payload["approval_class"] = json!("none");
    let eligible = evaluate(no_approval.clone(), None, &context()).unwrap();
    assert_eq!(
        eligible
            .receipt("receipt-no-approval", Outcome::Canceled, NOW)
            .unwrap()
            .approval_message_id,
        None
    );

    let mut wrong_kind = proposal();
    wrong_kind.kind = "turn.text".into();
    assert!(matches!(
        evaluate(wrong_kind, None, &context()),
        Err(SurfaceError::InvalidEnvelope)
    ));
    let mut wrong_session = proposal();
    wrong_session.session_id = "other-session".into();
    assert!(matches!(
        evaluate(wrong_session, None, &context()),
        Err(SurfaceError::ScopeMismatch)
    ));
    let mut payload_session = proposal();
    payload_session.payload["session_id"] = json!("other-session");
    assert!(matches!(
        evaluate(payload_session, None, &context()),
        Err(SurfaceError::InvalidEnvelope)
    ));

    let p = proposal();
    assert!(matches!(
        approve_locally(&p, "approval", "actor", "2026-07-11T11:59:59.000Z"),
        Err(SurfaceError::ApprovalTimeInvalid)
    ));
    assert!(matches!(
        approve_locally(&p, "approval", "actor", EXPIRES),
        Err(SurfaceError::ApprovalTimeInvalid)
    ));
    assert_eq!(
        proposal_digest(&Envelope {
            kind: "turn.text".into(),
            ..p.clone()
        })
        .unwrap()
        .len(),
        64
    );
}
