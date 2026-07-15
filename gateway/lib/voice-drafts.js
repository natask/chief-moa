"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Readable } = require("node:stream");
const { isDeepStrictEqual } = require("node:util");

const STORE_KIND = "voice_draft";
const EXPIRED_REPLAY_KIND = "voice_draft_expired_replay";
const STORE_REVISION = "voice_draft_store.v2";
const STATE_MACHINE_REVISION = "voice_draft_state.v1";
const PROCESS_BOOT_ID = crypto.randomBytes(12).toString("hex");
const CANONICAL_CONTENT_TYPE = "audio/L16; rate=16000; channels=1";
const CANONICAL_ENCODING = "pcm16";
const CANONICAL_AUDIO_FILE = "audio.pcm";
const META_FILE = "meta.json";
const JOURNAL_FILE = "append-journal.json";
const REPLAY_INDEX_FILE = "expired-replay-index.json";
const CAPTURE_LOCK_FILE = "capture.lock";
const STORE_LOCK_FILE = "store.lock";
const DRAFT_LOCK_FILE = "meta.lock";
const ACTIVE_CAPTURE_STATES = new Set(["capturing", "paused"]);
const APPENDABLE_STATES = new Set(["capturing"]);
const TERMINAL_STATES = new Set(["sent", "discarded"]);
const LEGAL_TRANSITIONS = Object.freeze({
  capturing: new Set(["pause", "park", "send_ready", "discard"]),
  paused: new Set(["resume", "park", "send_ready", "discard"]),
  parked: new Set(["resume", "send_ready", "discard"]),
  send_ready: new Set(["discard"]),
  sent: new Set([]),
  discarded: new Set([]),
});

const DEFAULT_MAX_DRAFTS = 128;
const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_SEGMENT_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_SEGMENTS_PER_DRAFT = 256;
const DEFAULT_MAX_SEGMENT_DURATION_MS = 10 * 60 * 1000;
const DEFAULT_MAX_DRAFT_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_DRAFT_DURATION_MS = 60 * 60 * 1000;
const DEFAULT_MAX_LIST_LIMIT = 200;
const DEFAULT_MAX_PARTIAL_TRANSCRIPT_CHARS = 2000;
const DEFAULT_MAX_CORRELATION_LENGTH = 120;
const DEFAULT_MAX_ACTOR_LENGTH = 120;
const DEFAULT_MAX_RECEIPT_LENGTH = 200;
const DEFAULT_INITIAL_REVISION = 1;
const DEFAULT_MAX_TRANSITION_HISTORY = 64;
const DEFAULT_MAX_ACTION_KEY_HASHES = 256;
const DEFAULT_MAX_METADATA_BYTES = 512 * 1024;
const DEFAULT_MAX_TERMINAL_DRAFTS = 128;
const DEFAULT_MAX_EXPIRED_REPLAY_RECORDS = 512;
const DEFAULT_MAX_REPLAY_INDEX_BYTES = 64 * 1024 * 1024;
const REPLAY_INDEX_BASE_RESERVATION_BYTES = 32 * 1024;
const REPLAY_INDEX_HASH_RESERVATION_BYTES = 80;
const MAX_OWNER_RECORD_BYTES = 16 * 1024;
const DEFAULT_LOCK_STALE_MS = 30 * 1000;
const AUTHORITY_TOKEN_PATTERN = /^[A-Za-z0-9._:-]+$/;
const ATOMIC_TMP_PATTERN = /^(meta\.json|append-journal\.json)\.\d+\.[a-f0-9]{8}\.tmp$/;
const REPLAY_INDEX_TMP_PATTERN = /^expired-replay-index\.json\.\d+\.[a-f0-9]{8}\.tmp$/;
const STORED_DRAFT_FIELDS = Object.freeze([
  "kind",
  "store_revision",
  "state_machine_revision",
  "revision",
  "id",
  "state",
  "source",
  "surface",
  "source_session_id",
  "session_id",
  "branch_id",
  "parent_intent_id",
  "release_id",
  "release_version",
  "context_action",
  "created_at",
  "updated_at",
  "state_updated_at",
  "resumed_at",
  "resume_count",
  "capture_lease",
  "create_request",
  "mutation_anchor",
  "authority_chain",
  "partial_transcript",
  "partial_transcript_updated_at",
  "audio",
  "segments",
  "transition_history",
  "used_action_key_hashes",
  "claim",
  "claim_request",
  "sent_receipt",
  "sent_request",
  "send_ready_receipt",
  "discard_receipt",
  "parked_receipt",
  "recovery_receipt",
  "tombstone",
  "cleanup_pending",
]);
const EXPIRED_REPLAY_FIELDS = Object.freeze([
  "kind",
  "store_revision",
  "state_machine_revision",
  "draft_id",
  "state",
  "terminal_state",
  "create_request",
  "terminal_request",
  "terminal_receipt",
  "terminal_history",
  "claim",
  "claim_request",
  "final_revision",
  "final_mutation_anchor",
  "used_action_key_hashes",
  "expired_at",
  "decision_sha256",
]);
const REPLAY_INDEX_FIELDS = Object.freeze([
  "kind",
  "store_revision",
  "state_machine_revision",
  "revision",
  "records_by_draft",
  "draft_by_create_hash",
]);
const AUTHORITY_CHAIN_FIELDS = Object.freeze([
  "type",
  "revision",
  "draft_id",
  "mutation",
  "operation",
  "previous_revision",
  "draft_revision",
  "state_before",
  "state_after",
  "at",
  "request_sha256",
  "action_key_hash",
  "system_recovery",
  "pre_content",
  "evidence_sha256",
  "previous_chain_sha256",
  "chain_sha256",
]);
const PRE_CONTENT_FIELDS = Object.freeze([
  "bytes",
  "duration_ms",
  "segment_count",
  "audio_sha256",
  "segments_sha256",
  "partial_transcript_sha256",
  "partial_transcript_updated_at",
]);
const AUTHORITY_CHAIN_OPERATIONS = new Set([
  "create",
  "append",
  "pause",
  "resume",
  "park",
  "recovery_park",
  "send_ready",
  "discard",
  "claim_for_turn",
  "mark_sent",
]);

function createVoiceDraftStore(options = {}) {
  const dataDir = path.resolve(options.dataDir || "./data");
  const draftsDir = path.join(dataDir, "voice-drafts");
  if (pathEntryExists(draftsDir)) {
    assertDirectoryBoundary(draftsDir, "voice draft store");
  } else {
    ensurePrivateDirectory(draftsDir, "voice draft store");
  }

  const testHooks = options.testHooks && typeof options.testHooks === "object" ? options.testHooks : {};
  const limits = normalizeLimits(options);
  Object.defineProperty(limits, "testHooks", { value: testHooks, enumerable: false });
  const mirrorEvent = typeof options.mirrorEvent === "function" ? options.mirrorEvent : () => {};
  const lockOptions = {
    staleMs: positiveInt(options.lockStaleMs, DEFAULT_LOCK_STALE_MS),
    testHooks,
  };

  assertDirectoryBoundary(draftsDir, "voice draft store");
  assertExactStoreRoot(draftsDir, limits);
  ensurePrivateDirectory(draftsDir, "voice draft store");
  withStoreLock(draftsDir, lockOptions, () => {
    recoverDrafts(draftsDir, limits, testHooks, lockOptions);
    compactTerminalDrafts(draftsDir, limits, lockOptions);
  });

  function create(input = {}) {
    const partialTranscript = boundedPartialTranscript(
      aliasedInput(input, ["partial_transcript", "partialTranscript"], "partial_transcript"),
      limits,
    );
    const createRequest = normalizeCreateRequest(input, limits);
    return withStoreLock(draftsDir, lockOptions, () => {
      const replay = findCreateResult(draftsDir, createRequest, limits);
      if (replay) {
        return clone(replay);
      }
      compactTerminalDrafts(draftsDir, limits, lockOptions);
      assertReplayAdmissionAvailable(draftsDir, limits, 1);
      if (countCapacityDrafts(draftsDir, limits) >= limits.maxDrafts) {
        throw statusError(507, "voice draft active capacity exceeded; terminal replay records were preserved");
      }
      const now = new Date().toISOString();
      const id = createDraftId();
      const lease = acquireCaptureLease(draftsDir, {
        draft_id: id,
        lease_id: createRequest.capture_lease_id,
        at: now,
      }, lockOptions);
      const draft = {
        kind: STORE_KIND,
        store_revision: STORE_REVISION,
        state_machine_revision: STATE_MACHINE_REVISION,
        revision: DEFAULT_INITIAL_REVISION,
        id,
        state: "capturing",
        source: createRequest.source,
        surface: createRequest.surface,
        source_session_id: createRequest.source_session_id,
        session_id: createRequest.session_id,
        branch_id: createRequest.branch_id,
        parent_intent_id: createRequest.parent_intent_id,
        release_id: createRequest.release_id,
        release_version: createRequest.release_version,
        context_action: createRequest.context_action,
        created_at: now,
        updated_at: now,
        state_updated_at: now,
        resumed_at: "",
        resume_count: 0,
        capture_lease: lease,
        create_request: createRequest,
        mutation_anchor: null,
        authority_chain: [],
        partial_transcript: partialTranscript,
        partial_transcript_updated_at: now,
        audio: emptyAudioRecord(),
        segments: [],
        transition_history: [],
        used_action_key_hashes: [],
        claim: null,
        claim_request: null,
        sent_receipt: null,
        sent_request: null,
        send_ready_receipt: null,
        discard_receipt: null,
        parked_receipt: null,
        recovery_receipt: null,
        tombstone: null,
        cleanup_pending: null,
      };
      appendMutationAuthority(draft, {
        mutation: "create",
        operation: "create",
        request: createRequest,
        at: now,
        previousRevision: 0,
        stateBefore: "",
      });
      try {
        writeDraftRecord(draftsDir, draft, limits);
      } catch (error) {
        const metaPath = metadataPathForDraft(draftsDir, id);
        if (!pathEntryExists(metaPath)) {
          releaseCaptureLeaseIfOwned(draftsDir, lease);
          removeEmptyDraftDirectory(draftsDir, id);
        }
        throw error;
      }
      safeMirror(mirrorEvent, summarizeEvent("created", draft, { state: draft.state }));
      return clone(draft);
    });
  }

  function appendSegment(draftId, input = {}) {
    return withStoreLock(draftsDir, lockOptions, () => withMutableDraftLock(draftsDir, draftId, limits, lockOptions, () => {
      const draft = reconcileDraftBeforeMutation(draftsDir, draftId, limits);
      const segmentId = requireExactToken(
        aliasedInput(input, ["segment_id", "segmentId"], "segment_id"),
        "segment_id",
        DEFAULT_MAX_CORRELATION_LENGTH,
      );
      const bytes = normalizeCanonicalPcmBytes(input.bytes);
      const digest = digestBytes(bytes);
      const durationMs = normalizeBoundedInteger(
        aliasedInput(input, ["duration_ms", "durationMs"], "duration_ms"),
        limits.maxSegmentDurationMs,
        "duration_ms",
      );
      const requestedContentType = aliasedInput(input, ["content_type", "contentType"], "content_type");
      const contentType = normalizeCanonicalContentType(requestedContentType || draft.audio.content_type);
      const declaredBytesInput = firstOwnInput(input, ["byte_count", "byteCount", "bytes_count", "bytesCount"]);
      const hasDeclaredBytes = declaredBytesInput.present;
      const declaredBytes = hasDeclaredBytes
        ? normalizeOptionalByteCount(
          aliasedInput(input, ["byte_count", "byteCount", "bytes_count", "bytesCount"], "byte_count"),
        )
        : 0;
      const declaredSha = normalizeOptionalDigest(input.sha256);
      const expectedRevision = normalizeExpectedRevision(
        aliasedInput(input, ["expected_revision", "expectedRevision"], "expected_revision"),
      );
      const partialTranscript = boundedPartialTranscript(
        aliasedInput(input, ["partial_transcript", "partialTranscript"], "partial_transcript"),
        limits,
      );
      if (hasDeclaredBytes && declaredBytes !== bytes.length) {
        throw statusError(409, "voice draft segment byte count does not match provided bytes");
      }
      if (declaredSha && declaredSha !== digest) {
        throw statusError(409, "voice draft segment digest does not match provided bytes");
      }

      const appendRequest = {
        type: "voice_draft_append_request",
        revision: STATE_MACHINE_REVISION,
        draft_id: draft.id,
        segment_id: segmentId,
        expected_revision: expectedRevision,
        content_type: contentType,
        duration_ms: durationMs,
        bytes: bytes.length,
        sha256: digest,
        declared_byte_count: hasDeclaredBytes ? declaredBytes : null,
        declared_sha256: declaredSha || null,
        partial_transcript_sha256: partialTranscript ? digestBytes(Buffer.from(partialTranscript, "utf8")) : "",
      };
      const existing = draft.segments.find((segment) => segment.segment_id === segmentId);
      if (existing) {
        if (!existing.append_request || !sameJson(existing.append_request, appendRequest)) {
          throw statusError(409, `voice draft segment ${segmentId} already exists with different content`);
        }
        return clone(existing);
      }

      assertExpectedRevisionValue(draft, expectedRevision);
      assertMutationRevisionCapacity(draft);
      assertCaptureLeaseMatches(draftsDir, draft);
      if (!APPENDABLE_STATES.has(draft.state)) {
        throw statusError(409, `voice draft ${draft.id} is ${draft.state}; segments may append only while capturing`);
      }
      if (draft.audio.segment_count >= limits.maxSegmentsPerDraft) {
        throw statusError(507, "voice draft segment cap exceeded; no stored segments were pruned");
      }
      if (bytes.length > limits.maxSegmentBytes) {
        throw statusError(507, "voice draft segment byte cap exceeded");
      }
      const nextDraftBytes = safeMutationSum(draft.audio.total_bytes, bytes.length, "draft bytes");
      const nextDraftDuration = safeMutationSum(draft.audio.total_duration_ms, durationMs, "draft duration");
      if (nextDraftBytes > limits.maxDraftBytes) {
        throw statusError(507, "voice draft byte cap exceeded; no stored segments were pruned");
      }
      if (nextDraftDuration > limits.maxDraftDurationMs) {
        throw statusError(507, "voice draft duration cap exceeded; no stored segments were pruned");
      }
      if (safeMutationSum(currentTotalBytes(draftsDir, limits), bytes.length, "store bytes") > limits.maxTotalBytes) {
        throw statusError(507, "voice draft storage quota exceeded; no stored drafts were pruned");
      }

      const now = new Date().toISOString();
      const audioPath = canonicalAudioPath(draftsDir, draft.id);
      const preDigest = draft.audio.sha256;
      const preBytes = draft.audio.total_bytes;
      const preDuration = draft.audio.total_duration_ms;
      const segment = {
        segment_id: segmentId,
        ordinal: draft.segments.length + 1,
        offset: preBytes,
        content_type: contentType,
        encoding: CANONICAL_ENCODING,
        bytes: bytes.length,
        duration_ms: durationMs,
        sha256: digest,
        created_at: now,
        append_request: appendRequest,
      };
      const resultBytes = nextDraftBytes;
      const resultDuration = nextDraftDuration;
      const journal = {
        type: "voice_draft_append_journal",
        revision: STATE_MACHINE_REVISION,
        draft_id: draft.id,
        segment,
        pre: {
          revision: draft.revision,
          bytes: preBytes,
          duration_ms: preDuration,
          sha256: preDigest,
          segment_count: draft.segments.length,
        },
        post: {
          bytes: resultBytes,
          duration_ms: resultDuration,
          sha256: "",
          segment_count: draft.segments.length + 1,
        },
        partial_transcript: partialTranscript,
        created_at: now,
      };

      writeDraftJsonAtomic(draftsDir, draft.id, JOURNAL_FILE, journal, limits, "voice draft append journal");
      runHook(testHooks, "afterAppendJournalWrite", { draftId: draft.id, segmentId });

      appendAudioBytes(draftsDir, draft.id, audioPath, draft.audio, bytes);
      journal.post.sha256 = digestDraftFile(draftsDir, draft.id, audioPath, "voice draft audio digest");
      writeDraftJsonAtomic(draftsDir, draft.id, JOURNAL_FILE, journal, limits, "voice draft append journal");
      runHook(testHooks, "afterAppendPersistedBeforeMeta", { draftId: draft.id, segmentId });

      draft.segments.push(segment);
      draft.audio = {
        path: CANONICAL_AUDIO_FILE,
        content_type: contentType,
        encoding: CANONICAL_ENCODING,
        total_bytes: resultBytes,
        total_duration_ms: resultDuration,
        segment_count: draft.segments.length,
        sha256: journal.post.sha256,
      };
      if (journal.partial_transcript) {
        draft.partial_transcript = journal.partial_transcript;
        draft.partial_transcript_updated_at = now;
      }
      draft.updated_at = now;
      bumpRevision(draft);
      appendMutationAuthority(draft, {
        mutation: "append",
        operation: "append",
        request: appendRequest,
        at: now,
        stateBefore: "capturing",
      });
      writeDraftRecord(draftsDir, draft, limits);
      clearJournal(draftsDir, draft.id);
      safeMirror(mirrorEvent, summarizeEvent("segment_appended", draft, {
        segment_id: segment.segment_id,
        ordinal: segment.ordinal,
        bytes: segment.bytes,
      }));
      return clone(segment);
    }));
  }

  function transition(draftId, input = {}) {
    return withStoreLock(draftsDir, lockOptions, () => {
      const result = withMutableDraftLock(draftsDir, draftId, limits, lockOptions, () => {
        const draft = reconcileDraftBeforeMutation(draftsDir, draftId, limits);
      const action = normalizeAction(input.action);
      const actor = normalizeActor(input.actor);
      const idempotencyKey = requireIdempotencyKey(
        aliasedInput(input, ["idempotency_key", "idempotencyKey"], "idempotency_key"),
      );
      if (idempotencyKey.startsWith("recovery-park:")) {
        throw statusError(400, "recovery-park idempotency keys are reserved for system recovery");
      }
      const expectedRevision = normalizeExpectedRevision(
        aliasedInput(input, ["expected_revision", "expectedRevision"], "expected_revision"),
      );
      const request = canonicalTransitionRequest(draft.id, action, idempotencyKey, actor, expectedRevision);
      const duplicate = findRecordedAction(draft, request);
      if (duplicate) {
        return clone(duplicate);
      }
      assertExpectedRevisionValue(draft, expectedRevision);
      assertMutationRevisionCapacity(draft);
      assertLegalTransition(draft.state, action);
      if (draft.state === "paused" || draft.state === "capturing") {
        assertCaptureLeaseMatches(draftsDir, draft);
      }
      if (action === "send_ready" && draft.audio.segment_count <= 0) {
        throw statusError(409, "voice draft cannot become send_ready without audio segments");
      }

      const now = new Date().toISOString();
      const before = draft.state;
      const after = nextStateForAction(action);
      const preContent = action === "discard" ? currentContentAuthority(draft) : null;
      const priorCaptureLease = draft.capture_lease ? clone(draft.capture_lease) : null;
      let acquiredCaptureLease = null;
      const receipt = {
        type: "voice_draft_transition_receipt",
        revision: STATE_MACHINE_REVISION,
        draft_id: draft.id,
        action,
        idempotency_key: idempotencyKey,
        actor,
        state_before: before,
        state_after: after,
        at: now,
      };

      if (action === "pause") {
        // Paused retains the capture lease, but cannot accept appends.
      } else if (action === "resume") {
        if (draft.resume_count >= Number.MAX_SAFE_INTEGER) {
          throw statusError(507, "voice draft resume counter capacity exceeded");
        }
        draft.resume_count += 1;
        draft.resumed_at = now;
      } else if (action === "park") {
        draft.parked_receipt = {
          action: "park",
          at: now,
          actor,
          idempotency_key: idempotencyKey,
        };
      } else if (action === "send_ready") {
        draft.send_ready_receipt = {
          action: "send_ready",
          at: now,
          actor,
          idempotency_key: idempotencyKey,
          audio: {
            content_type: draft.audio.content_type,
            bytes: draft.audio.total_bytes,
            duration_ms: draft.audio.total_duration_ms,
            segment_count: draft.audio.segment_count,
          },
        };
      } else if (action === "discard") {
        draft.discard_receipt = {
          action: "discard",
          at: now,
          actor,
          idempotency_key: idempotencyKey,
        };
        prepareCleanupPending(draft, {
          mode: "discarded",
          at: now,
          actor,
          receiptId: idempotencyKey,
          clearClaim: true,
          clearSendReady: true,
        });
      }

      draft.state = after;
      draft.updated_at = now;
      draft.state_updated_at = now;
      if (action === "park" || action === "send_ready" || action === "discard") {
        draft.capture_lease = null;
      }
      rememberTransition(draft, request, receipt, limits);
      bumpRevision(draft);
      appendMutationAuthority(draft, {
        mutation: "transition",
        operation: action,
        request,
        at: now,
        stateBefore: before,
        actionKeyHash: hashIdempotencyKey(idempotencyKey),
        preContent,
      });
      if (action === "resume" && before === "parked") {
        acquiredCaptureLease = acquireCaptureLease(draftsDir, {
          draft_id: draft.id,
          lease_id: priorCaptureLease?.lease_id || "",
          at: now,
        }, lockOptions);
        draft.capture_lease = acquiredCaptureLease;
      }
      try {
        if (acquiredCaptureLease) {
          runHook(testHooks, "afterResumeLeaseAcquiredBeforeMeta", {
            draftId: draft.id,
            lease: clone(acquiredCaptureLease),
          });
        }
        writeDraftRecord(draftsDir, draft, limits);
      } catch (error) {
        const published = isVerifiedAmbiguousDraftPublication(
          error,
          draftsDir,
          draft,
          limits,
        );
        if (acquiredCaptureLease && !published) {
          releaseCaptureLeaseIfOwned(draftsDir, acquiredCaptureLease);
        }
        if (published && (action === "park" || action === "send_ready" || action === "discard")) {
          try {
            releaseCaptureLeaseIfOwned(draftsDir, priorCaptureLease);
          } catch (cleanupError) {
            error.lease_reconciliation_error = cleanupError.message;
          }
        }
        throw error;
      }
      if (action === "park" || action === "send_ready" || action === "discard") {
        releaseCaptureLeaseIfOwned(draftsDir, priorCaptureLease);
      }
      if (action === "discard") {
        runHook(testHooks, "afterCleanupMarkerWrite", { draftId: draft.id, action });
        completeCleanupPending(draftsDir, draft, limits);
      }
      safeMirror(mirrorEvent, summarizeEvent("transitioned", draft, {
        action,
        state_before: before,
        state_after: after,
      }));
        return clone(receipt);
      });
      compactTerminalDrafts(draftsDir, limits, lockOptions);
      return result;
    });
  }

  function get(draftId) {
    assertExactStoreRoot(draftsDir, limits);
    if (draftId === undefined || draftId === null || draftId === "") return null;
    const expired = findExpiredReplayByDraft(draftsDir, draftId, limits);
    if (expired) return clone(expired);
    const record = loadOptionalRecord(draftsDir, draftId, limits);
    return record ? clone(record) : null;
  }

  function list(filter = {}) {
    assertExactStoreRoot(draftsDir, limits);
    const limit = clampLimit(filter.limit, limits.maxListLimit);
    const states = normalizeStateFilter(filter.state || filter.states);
    const rawSessionId = aliasedInput(filter, ["session_id", "sessionId"], "session_id");
    const rawBranchId = aliasedInput(filter, ["branch_id", "branchId"], "branch_id");
    const sessionId = rawSessionId === undefined || rawSessionId === ""
      ? ""
      : requireAuthorityToken(rawSessionId, "session_id");
    const branchId = rawBranchId === undefined || rawBranchId === ""
      ? ""
      : requireAuthorityToken(rawBranchId, "branch_id");
    const surface = optionalAuthorityToken(filter.surface, "surface");
    const source = optionalAuthorityToken(filter.source, "source");
    const replayIndex = readReplayIndex(draftsDir, limits);
    return listAuthoritativeDraftIds(draftsDir)
      .filter((draftId) => !replayIndex.records_by_draft[draftId])
      .map((draftId) => loadOptionalRecord(draftsDir, draftId, limits))
      .filter(Boolean)
      .filter((draft) => draft.kind === STORE_KIND)
      .filter((draft) => !states || states.has(draft.state))
      .filter((draft) => !sessionId || draft.session_id === sessionId)
      .filter((draft) => !branchId || draft.branch_id === branchId)
      .filter((draft) => !surface || draft.surface === surface)
      .filter((draft) => !source || draft.source === source)
      .sort((left, right) => String(right.updated_at || "").localeCompare(String(left.updated_at || "")))
      .slice(0, limit)
      .map(clone);
  }

  function segments(draftId) {
    assertExactStoreRoot(draftsDir, limits);
    const expired = findExpiredReplayByDraft(draftsDir, draftId, limits);
    if (expired) throw expiredReplayError(expired);
    return loadRequiredDraft(draftsDir, draftId, limits).segments.map(clone);
  }

  function readAudio(draftId) {
    assertExactStoreRoot(draftsDir, limits);
    const expired = findExpiredReplayByDraft(draftsDir, draftId, limits);
    if (expired) throw expiredReplayError(expired);
    const draft = loadRequiredDraft(draftsDir, draftId, limits);
    if (draft.audio.segment_count <= 0 || !draft.audio.content_type) {
      throw statusError(409, "voice draft has no readable audio");
    }
    const audioPath = canonicalAudioPath(draftsDir, draft.id);
    const audioBoundary = assertDraftBoundary(draftsDir, draft.id, "voice draft audio handle");
    const audioIdentity = assertRegularFile(audioPath, "voice draft audio handle");
    validatePersistedAudio(draftsDir, draft, limits);
    const verifiedBoundary = assertDraftBoundary(draftsDir, draft.id, "voice draft audio handle");
    assertSameBoundary(audioBoundary, verifiedBoundary, "voice draft audio handle");
    const verifiedIdentity = assertRegularFile(audioPath, "voice draft audio handle");
    if (!sameFileIdentity(audioIdentity, verifiedIdentity)) {
      throw statusError(500, `voice draft ${draft.id} PCM inode changed while creating its audio handle`);
    }
    return {
      draft_id: draft.id,
      state: draft.state,
      content_type: draft.audio.content_type,
      encoding: draft.audio.encoding,
      bytes: draft.audio.total_bytes,
      duration_ms: draft.audio.total_duration_ms,
      segment_count: draft.audio.segment_count,
      path: audioPath,
      createReadStream() {
        const bytes = readVerifiedAudioSnapshot(
          draftsDir,
          draft,
          audioPath,
          audioBoundary,
          audioIdentity,
          testHooks,
          "stream",
        );
        return Readable.from([bytes]);
      },
      readBuffer() {
        return readVerifiedAudioSnapshot(
          draftsDir,
          draft,
          audioPath,
          audioBoundary,
          audioIdentity,
          testHooks,
          "buffer",
        );
      },
    };
  }

  function claimForTurn(draftId, input = {}) {
    return withStoreLock(draftsDir, lockOptions, () => withMutableDraftLock(draftsDir, draftId, limits, lockOptions, () => {
      const draft = reconcileDraftBeforeMutation(draftsDir, draftId, limits);
      if (draft.state !== "send_ready") {
        throw statusError(409, "only send_ready drafts may be claimed for a turn");
      }
      const claim = normalizeTurnClaim(input, draft);
      const expectedRevision = normalizeExpectedRevision(
        aliasedInput(input, ["expected_revision", "expectedRevision"], "expected_revision"),
      );
      const claimRequest = {
        type: "voice_draft_claim_request",
        revision: STATE_MACHINE_REVISION,
        draft_id: draft.id,
        action: "claim_for_turn",
        expected_revision: expectedRevision,
        ...claim,
      };
      if (draft.claim) {
        if (draft.claim_request && sameJson(draft.claim_request, claimRequest)) {
          return clone(draft.claim);
        }
        throw statusError(409, `voice draft ${draft.id} already claimed for turn ${draft.claim.turn_id}`);
      }
      assertExpectedRevisionValue(draft, expectedRevision);
      assertMutationRevisionCapacity(draft);
      const now = new Date().toISOString();
      draft.claim = { ...claim, claimed_at: now };
      draft.claim_request = claimRequest;
      draft.updated_at = now;
      bumpRevision(draft);
      appendMutationAuthority(draft, {
        mutation: "claim",
        operation: "claim_for_turn",
        request: claimRequest,
        at: now,
        stateBefore: "send_ready",
      });
      writeDraftRecord(draftsDir, draft, limits);
      safeMirror(mirrorEvent, summarizeEvent("claimed_for_turn", draft, claim));
      return clone(draft.claim);
    }));
  }

  function markSent(draftId, input = {}) {
    return withStoreLock(draftsDir, lockOptions, () => {
      const result = withMutableDraftLock(draftsDir, draftId, limits, lockOptions, () => {
        const existingDraft = reconcileDraftBeforeMutation(draftsDir, draftId, limits);
      const sentCommand = normalizeSentCommand(input, existingDraft);
      const { receipt, request } = sentCommand;
      if (existingDraft.sent_receipt) {
        if (existingDraft.sent_request && sameJson(existingDraft.sent_request, request)) {
          return clone(existingDraft.sent_receipt);
        }
        throw statusError(409, `voice draft ${existingDraft.id} already marked sent`);
      }
      if (findRecordedAction(existingDraft, request)) {
        throw statusError(409, `voice draft ${existingDraft.id} mark-sent action was recorded without a sent receipt`);
      }
      if (existingDraft.state !== "send_ready") {
        throw statusError(409, "only send_ready drafts may be marked sent");
      }
      if (!existingDraft.claim) {
        throw statusError(409, "voice draft must be claimed before markSent");
      }
      assertExpectedRevisionValue(existingDraft, request.expected_revision);
      assertMutationRevisionCapacity(existingDraft);
      if (
        existingDraft.claim.session_id !== receipt.session_id ||
        existingDraft.claim.branch_id !== receipt.branch_id ||
        existingDraft.claim.turn_id !== receipt.turn_id
      ) {
        throw statusError(409, "sent receipt must match the claimed turn");
      }
      const preContent = currentContentAuthority(existingDraft);
      existingDraft.state = "sent";
      existingDraft.updated_at = receipt.sent_at;
      existingDraft.state_updated_at = receipt.sent_at;
      existingDraft.capture_lease = null;
      existingDraft.sent_receipt = receipt;
      existingDraft.sent_request = request;
      prepareCleanupPending(existingDraft, {
        mode: "sent",
        at: receipt.sent_at,
        actor: receipt.actor,
        receiptId: receipt.receipt_id,
        clearClaim: false,
        clearSendReady: false,
      });
      rememberTransition(existingDraft, request, {
        type: "voice_draft_transition_receipt",
        revision: STATE_MACHINE_REVISION,
        draft_id: existingDraft.id,
        action: "mark_sent",
        idempotency_key: receipt.receipt_id,
        actor: receipt.actor,
        state_before: "send_ready",
        state_after: "sent",
        at: receipt.sent_at,
      }, limits);
      bumpRevision(existingDraft);
      appendMutationAuthority(existingDraft, {
        mutation: "transition",
        operation: "mark_sent",
        request,
        at: receipt.sent_at,
        stateBefore: "send_ready",
        actionKeyHash: hashIdempotencyKey(receipt.receipt_id),
        preContent,
      });
      writeDraftRecord(draftsDir, existingDraft, limits);
      runHook(testHooks, "afterCleanupMarkerWrite", { draftId: existingDraft.id, action: "mark_sent" });
      completeCleanupPending(draftsDir, existingDraft, limits);
      safeMirror(mirrorEvent, summarizeEvent("marked_sent", existingDraft, {
        receipt_id: receipt.receipt_id,
        turn_id: receipt.turn_id,
      }));
        return clone(receipt);
      });
      compactTerminalDrafts(draftsDir, limits, lockOptions);
      return result;
    });
  }

  function discard(draftId, input = {}) {
    return transition(draftId, {
      action: "discard",
      idempotency_key: aliasedInput(input, ["idempotency_key", "idempotencyKey"], "idempotency_key"),
      actor: input.actor,
      expected_revision: aliasedInput(input, ["expected_revision", "expectedRevision"], "expected_revision"),
    });
  }

  function status() {
    const physicalStorage = inspectPhysicalStoreUsage(draftsDir, limits);
    const lease = readCaptureLeaseRecord(draftsDir, lockOptions);
    const replayIndex = readReplayIndex(draftsDir, limits);
    const directoryRecords = listAuthoritativeDraftIds(draftsDir)
      .map((draftId) => loadRequiredRecord(draftsDir, draftId, limits));
    const fullRecordCount = directoryRecords.filter((record) => record.kind === STORE_KIND).length;
    const legacyExpiredCount = directoryRecords.filter(
      (record) => record.kind === EXPIRED_REPLAY_KIND,
    ).length;
    const indexedExpiredCount = Object.keys(replayIndex.records_by_draft).length;
    const expiredReplayCount = legacyExpiredCount + indexedExpiredCount;
    const indexMetadataBytes = replayIndexMetadataBytes(draftsDir);
    const draftMetadataBytes = currentDraftMetadataBytes(draftsDir);
    return {
      kind: STORE_KIND,
      store_revision: STORE_REVISION,
      state_machine_revision: STATE_MACHINE_REVISION,
      drafts_dir: draftsDir,
      count: fullRecordCount + expiredReplayCount,
      full_record_count: fullRecordCount,
      capacity_count: countCapacityDrafts(draftsDir, limits),
      terminal_replay_count: countTerminalReplayDrafts(draftsDir, limits),
      expired_replay_count: expiredReplayCount,
      metadata_bytes: draftMetadataBytes + indexMetadataBytes,
      replay_index: {
        record_count: indexedExpiredCount,
        legacy_directory_record_count: legacyExpiredCount,
        metadata_bytes: indexMetadataBytes,
        max_records: limits.maxExpiredReplayRecords,
        max_metadata_bytes: limits.maxReplayIndexBytes,
        reserved_record_bytes: limits.expiredReplayRecordReservationBytes,
        admission_reserved_bytes: replayIndexEncodedBytes(replayIndex)
          + (directoryRecords.length * limits.expiredReplayRecordReservationBytes),
        lookup: "sha256_create_key_and_draft_id",
      },
      terminal_retention: {
        mode: "bounded_full_replay_with_bounded_keyed_expired_index",
        max_records: limits.maxTerminalDrafts,
        eviction_order: "oldest_draft_creation_first",
        exact_replay_scope: "retained_records",
        compacted_scope: "durable_expired_domain_outcome",
      },
      total_bytes: currentTotalBytes(draftsDir, limits),
      physical_storage: physicalStorage,
      active_capture_draft_id: isLiveLeaseRecord(lease) ? lease.draft_id : "",
      limits: clone(limits),
    };
  }

  return {
    draftsDir,
    create,
    appendSegment,
    transition,
    get,
    list,
    segments,
    readAudio,
    claimForTurn,
    markSent,
    discard,
    status,
  };
}

function recoverDrafts(draftsDir, limits, testHooks, lockOptions) {
  preflightDraftStore(draftsDir, limits);
  const lease = readCaptureLeaseRecord(draftsDir, lockOptions);
  if (lease && !isLiveLeaseRecord(lease)) {
    releaseCaptureLeaseIfOwned(draftsDir, lease);
  }
  for (const draftId of listDraftDirectoryIds(draftsDir)) {
    let removeEmptyDirectory = false;
    withDraftLock(draftsDir, draftId, lockOptions, () => {
      assertKnownDraftDirectoryScaffolding(draftsDir, draftId, "voice draft recovery");
      removeAtomicWriteTemps(draftDirForId(draftsDir, draftId));
      let record = loadOptionalRecord(draftsDir, draftId, limits);
      if (!record) {
        assertNoOrphanContent(draftsDir, draftId);
        assertNoUnexpectedOrphanFiles(draftsDir, draftId);
        removeEmptyDirectory = true;
        return;
      }
      if (record.kind === EXPIRED_REPLAY_KIND) {
        assertExactDraftDirectory(draftsDir, record);
        return;
      }
      let draft = record;
      reconcileAppendJournal(draftsDir, draft, limits);
      draft = loadRequiredDraft(draftsDir, draftId, limits);
      if (draft.cleanup_pending) {
        completeCleanupPending(draftsDir, draft, limits);
        draft = loadRequiredDraft(draftsDir, draftId, limits);
      }
      validatePersistedAudio(draftsDir, draft, limits);
      reconcileLeaseState(draftsDir, draft, limits, lockOptions);
    });
    if (removeEmptyDirectory) {
      removeEmptyDraftDirectory(draftsDir, draftId);
    }
  }
  const active = readCaptureLeaseRecord(draftsDir, lockOptions);
  if (active && !isLiveLeaseRecord(active)) {
    releaseCaptureLeaseIfOwned(draftsDir, active);
  } else if (active) {
    const activeRecord = loadOptionalRecord(draftsDir, active.draft_id, limits);
    if (!activeRecord || activeRecord.kind !== STORE_KIND) {
      releaseCaptureLeaseIfOwned(draftsDir, active);
      if (pathEntryExists(path.join(draftsDir, CAPTURE_LOCK_FILE))) {
        throw statusError(500, `voice draft interrupted capture lease ${active.draft_id} could not be recovered`);
      }
    }
  }
}

function preflightDraftStore(draftsDir, limits) {
  const records = [];
  const createAuthorities = new Map();
  const replayIndex = readReplayIndex(draftsDir, limits);
  for (const record of Object.values(replayIndex.records_by_draft)) {
    createAuthorities.set(record.create_request.idempotency_key, {
      draftId: record.draft_id,
      expired: record,
    });
  }
  for (const draftId of listDraftDirectoryIds(draftsDir)) {
    assertKnownDraftDirectoryScaffolding(draftsDir, draftId, "voice draft preflight");
    const record = loadOptionalRecord(draftsDir, draftId, limits, { skipPhysicalValidation: true });
    if (!record) {
      assertNoOrphanContent(draftsDir, draftId);
      assertNoUnexpectedOrphanFiles(draftsDir, draftId, { allowAtomicTemps: true });
      records.push({ draftId, record: null });
      continue;
    }
    const createKey = record.create_request.idempotency_key;
    if (createAuthorities.has(createKey)) {
      const prior = createAuthorities.get(createKey);
      if (
        prior.expired
        && prior.draftId === draftId
        && record.kind === STORE_KIND
        && isTerminalReplayDraft(record)
      ) {
        assertExpiredReplayMatchesDraft(prior.expired, record, limits);
      } else {
        throw statusError(
          500,
          `voice draft create idempotency authority ${createKey} is duplicated by ${prior.draftId} and ${draftId}`,
        );
      }
    } else {
      createAuthorities.set(createKey, { draftId, expired: null });
    }
    assertExactDraftDirectory(draftsDir, record, {
      allowAtomicTemps: true,
      allowRecoverableLock: true,
    });
    if (record.kind === STORE_KIND) {
      const journalPath = journalPathForDraft(draftsDir, record.id);
      if (pathEntryExists(journalPath)) {
        normalizeStoredAppendJournal(
          readDraftJsonFile(
            draftsDir,
            record.id,
            journalPath,
            "voice draft append journal",
            limits.maxMetadataBytes,
          ),
          record,
          limits,
        );
      }
    }
    records.push({ draftId, record });
  }

  let totalBytes = 0;
  for (const { draftId, record } of records) {
    if (!record) {
      removeAtomicWriteTemps(draftDirForId(draftsDir, draftId));
      assertNoOrphanContent(draftsDir, draftId);
      assertNoUnexpectedOrphanFiles(draftsDir, draftId);
      continue;
    }
    removeAtomicWriteTemps(draftDirForId(draftsDir, draftId));
    assertExactDraftDirectory(draftsDir, record, { allowRecoverableLock: true });
    if (record.kind === EXPIRED_REPLAY_KIND) {
      continue;
    }
    const draft = record;
    const journalPath = journalPathForDraft(draftsDir, draft.id);
    if (!pathEntryExists(journalPath) && !draft.cleanup_pending) {
      validatePersistedAudio(draftsDir, draft, limits);
    }
    totalBytes = safeStoredSum(totalBytes, accountedDraftBytes(draftsDir, draft, limits), "store bytes");
    if (totalBytes > limits.maxTotalBytes) {
      throw statusError(500, "voice draft persisted store exceeds configured total byte limit");
    }
  }
  assertReplayAdmissionAvailable(draftsDir, limits, 0);
  removeReplayIndexTemps(draftsDir);
}

function reconcileDraftBeforeMutation(draftsDir, draftId, limits) {
  assertKnownDraftDirectoryScaffolding(draftsDir, draftId, "voice draft mutation recovery");
  const preflightRecord = loadOptionalRecord(
    draftsDir,
    draftId,
    limits,
    { skipPhysicalValidation: true },
  );
  if (!preflightRecord) {
    throw statusError(404, "voice draft not found");
  }
  if (preflightRecord.kind === EXPIRED_REPLAY_KIND) {
    throw expiredReplayError(preflightRecord);
  }
  removeAtomicWriteTemps(draftDirForId(draftsDir, draftId));
  let draft = loadRequiredDraft(draftsDir, draftId, limits);
  reconcileAppendJournal(draftsDir, draft, limits);
  draft = loadRequiredDraft(draftsDir, draftId, limits);
  if (draft.cleanup_pending) {
    completeCleanupPending(draftsDir, draft, limits);
    draft = loadRequiredDraft(draftsDir, draftId, limits);
  }
  validatePersistedAudio(draftsDir, draft, limits);
  return draft;
}

function reconcileLeaseState(draftsDir, draft, limits, lockOptions) {
  const lease = readCaptureLeaseRecord(draftsDir, lockOptions);
  if (!ACTIVE_CAPTURE_STATES.has(draft.state)) {
    if (lease && lease.draft_id === draft.id) {
      releaseCaptureLeaseIfOwned(draftsDir, lease);
    }
    if (draft.capture_lease) {
      draft.capture_lease = null;
      writeDraftRecord(draftsDir, draft, limits);
    }
    return;
  }
  if (lease && lease.draft_id === draft.id && isLiveLeaseRecord(lease)) {
    if (!sameJson(stripLeaseEvidence(draft.capture_lease), stripLeaseEvidence(lease))) {
      draft.capture_lease = clone(lease);
      writeDraftRecord(draftsDir, draft, limits);
    }
    return;
  }

  const now = new Date().toISOString();
  const recoveredFrom = draft.state;
  const recoveryKey = `recovery-park:${draft.id}:${draft.resume_count}`;
  draft.state = "parked";
  draft.updated_at = now;
  draft.state_updated_at = now;
  draft.capture_lease = null;
  draft.parked_receipt = {
    action: "park",
    at: now,
    actor: { kind: "system", id: "boot-recovery" },
    idempotency_key: recoveryKey,
  };
  draft.recovery_receipt = {
    type: "voice_draft_recovery_receipt",
    revision: STATE_MACHINE_REVISION,
    recovered_from: recoveredFrom,
    at: now,
    reason: "boot_recovery_auto_park",
    idempotency_key: recoveryKey,
    expected_revision: draft.revision,
    decision_sha256: "",
  };
  draft.recovery_receipt.decision_sha256 = digestCanonicalValue(
    recoveryReceiptDecisionPayload(draft.recovery_receipt),
  );
  const recoveryRequest = canonicalTransitionRequest(
    draft.id,
    "park",
    recoveryKey,
    { kind: "system", id: "boot-recovery" },
    draft.revision,
  );
  rememberTransition(draft, recoveryRequest, {
    type: "voice_draft_transition_receipt",
    revision: STATE_MACHINE_REVISION,
    draft_id: draft.id,
    action: "park",
    idempotency_key: recoveryKey,
    actor: { kind: "system", id: "boot-recovery" },
    state_before: recoveredFrom,
    state_after: "parked",
    at: now,
  }, limits, { systemRecovery: true });
  bumpRevision(draft);
  appendMutationAuthority(draft, {
    mutation: "transition",
    operation: "recovery_park",
    request: recoveryRequest,
    at: now,
    stateBefore: recoveredFrom,
    actionKeyHash: hashIdempotencyKey(recoveryKey),
    systemRecovery: true,
  });
  writeDraftRecord(draftsDir, draft, limits);
  if (lease && lease.draft_id === draft.id) {
    releaseCaptureLeaseIfOwned(draftsDir, lease);
  }
}

function reconcileAppendJournal(draftsDir, draft, limits) {
  assertDraftBoundary(draftsDir, draft.id, "voice draft journal reconciliation");
  const journalPath = journalPathForDraft(draftsDir, draft.id);
  if (!pathEntryExists(journalPath)) {
    return;
  }
  const journal = normalizeStoredAppendJournal(
    readDraftJsonFile(
      draftsDir,
      draft.id,
      journalPath,
      "voice draft append journal",
      limits.maxMetadataBytes,
    ),
    draft,
    limits,
  );
  const audioPath = canonicalAudioPath(draftsDir, draft.id);
  const actualSize = pathEntryExists(audioPath) ? assertRegularFile(audioPath, "voice draft journal audio").size : 0;
  const pre = journal.pre || {};
  const post = journal.post || {};
  if (
    actualSize === post.bytes
    && post.sha256
    && digestDraftFile(draftsDir, draft.id, audioPath, "voice draft journal audio") === post.sha256
  ) {
    const current = loadRequiredDraft(draftsDir, draft.id, limits);
    if (!current.segments.find((segment) => segment.segment_id === journal.segment.segment_id)) {
      current.segments.push(journal.segment);
      current.audio = {
        path: CANONICAL_AUDIO_FILE,
        content_type: CANONICAL_CONTENT_TYPE,
        encoding: CANONICAL_ENCODING,
        total_bytes: post.bytes,
        total_duration_ms: post.duration_ms,
        segment_count: post.segment_count,
        sha256: post.sha256,
      };
      if (journal.partial_transcript) {
        current.partial_transcript = journal.partial_transcript;
        current.partial_transcript_updated_at = new Date().toISOString();
      }
      current.updated_at = new Date().toISOString();
      bumpRevision(current);
      appendMutationAuthority(current, {
        mutation: "append",
        operation: "append",
        request: journal.segment.append_request,
        at: current.updated_at,
        stateBefore: "capturing",
      });
      writeDraftRecord(draftsDir, current, limits);
    }
    clearJournal(draftsDir, draft.id);
    return;
  }
  if (actualSize >= pre.bytes) {
    const fd = openDraftFile(
      draftsDir,
      draft.id,
      audioPath,
      fs.constants.O_RDWR | fs.constants.O_CREAT,
      "voice draft journal audio",
      0o600,
    );
    try {
      fs.ftruncateSync(fd, pre.bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
  const currentDigest = pre.bytes > 0
    ? digestDraftFile(draftsDir, draft.id, audioPath, "voice draft journal audio")
    : "";
  if (pre.bytes !== 0 && currentDigest !== pre.sha256) {
    throw statusError(500, `voice draft ${draft.id} audio journal recovery failed digest reconciliation`);
  }
  if (pre.bytes === 0 && pathEntryExists(audioPath)) {
    removeRegularFileVerified(audioPath, "rolled-back empty voice draft audio");
  }
  clearJournal(draftsDir, draft.id);
}

function normalizeStoredAppendJournal(value, draft, limits) {
  if (!isPlainObject(value) || value.type !== "voice_draft_append_journal") {
    throw statusError(500, "voice draft append journal is invalid");
  }
  assertExactStoredFields(value, [
    "type",
    "revision",
    "draft_id",
    "segment",
    "pre",
    "post",
    "partial_transcript",
    "created_at",
  ], "append_journal");
  if (value.revision !== STATE_MACHINE_REVISION || value.draft_id !== draft.id) {
    throw statusError(500, "voice draft append journal authority is incompatible");
  }
  const segment = normalizeSegments([value.segment], limits)[0];
  validateStoredAppendRequest(segment.append_request, draft.id, segment);
  if (!isPlainObject(value.pre) || !isPlainObject(value.post)) {
    throw statusError(500, "voice draft append journal boundaries are invalid");
  }
  assertExactStoredFields(
    value.pre,
    ["revision", "bytes", "duration_ms", "sha256", "segment_count"],
    "append_journal.pre",
  );
  assertExactStoredFields(
    value.post,
    ["bytes", "duration_ms", "sha256", "segment_count"],
    "append_journal.post",
  );
  const pre = {
    revision: requireStoredPositiveInteger(value.pre.revision, "append_journal.pre.revision"),
    bytes: requireStoredNonNegativeInteger(value.pre.bytes, "append_journal.pre.bytes"),
    duration_ms: requireStoredNonNegativeInteger(value.pre.duration_ms, "append_journal.pre.duration_ms"),
    sha256: requireStoredDigest(value.pre.sha256, "append_journal.pre.sha256", true),
    segment_count: requireStoredNonNegativeInteger(
      value.pre.segment_count,
      "append_journal.pre.segment_count",
    ),
  };
  const post = {
    bytes: requireStoredNonNegativeInteger(value.post.bytes, "append_journal.post.bytes"),
    duration_ms: requireStoredNonNegativeInteger(value.post.duration_ms, "append_journal.post.duration_ms"),
    sha256: requireStoredDigest(value.post.sha256, "append_journal.post.sha256", true),
    segment_count: requireStoredPositiveInteger(value.post.segment_count, "append_journal.post.segment_count"),
  };
  if (
    pre.bytes > limits.maxDraftBytes
    || post.bytes > limits.maxDraftBytes
    || pre.duration_ms > limits.maxDraftDurationMs
    || post.duration_ms > limits.maxDraftDurationMs
    || pre.segment_count > limits.maxSegmentsPerDraft
    || post.segment_count > limits.maxSegmentsPerDraft
  ) {
    throw statusError(500, "voice draft append journal exceeds configured limits");
  }
  const expectedPostBytes = safeStoredSum(pre.bytes, segment.bytes, "append journal bytes");
  const expectedPostDuration = safeStoredSum(
    pre.duration_ms,
    segment.duration_ms,
    "append journal duration",
  );
  if (
    segment.offset !== pre.bytes
    || segment.ordinal !== pre.segment_count + 1
    || post.bytes !== expectedPostBytes
    || post.duration_ms !== expectedPostDuration
    || post.segment_count !== pre.segment_count + 1
  ) {
    throw statusError(500, "voice draft append journal arithmetic is inconsistent");
  }
  if ((pre.bytes === 0) !== (pre.sha256 === "")) {
    throw statusError(500, "voice draft append journal pre-digest is inconsistent");
  }
  const draftHasSegment = draft.segments.some((item) => item.segment_id === segment.segment_id);
  if (!draftHasSegment) {
    if (
      draft.revision !== pre.revision
      || draft.audio.total_bytes !== pre.bytes
      || draft.audio.total_duration_ms !== pre.duration_ms
      || draft.audio.segment_count !== pre.segment_count
      || draft.audio.sha256 !== pre.sha256
    ) {
      throw statusError(500, "voice draft append journal pre-state disagrees with metadata");
    }
  } else if (
    draft.audio.total_bytes !== post.bytes
    || draft.audio.total_duration_ms !== post.duration_ms
    || draft.audio.segment_count !== post.segment_count
    || !post.sha256
    || draft.audio.sha256 !== post.sha256
  ) {
    throw statusError(500, "voice draft append journal post-state disagrees with metadata");
  }
  return {
    type: value.type,
    revision: value.revision,
    draft_id: value.draft_id,
    segment,
    pre,
    post,
    partial_transcript: requireStoredBoundedText(
      value.partial_transcript,
      "append_journal.partial_transcript",
      limits.maxPartialTranscriptChars,
    ),
    created_at: requireStoredTimestamp(value.created_at, "append_journal.created_at"),
  };
}

function prepareCleanupPending(draft, input) {
  const priorAudio = clone(draft.audio || emptyAudioRecord());
  draft.partial_transcript = "";
  draft.partial_transcript_updated_at = input.at;
  if (input.clearClaim) {
    draft.claim = null;
    draft.claim_request = null;
  }
  if (input.clearSendReady) {
    draft.send_ready_receipt = null;
  }
  draft.audio = emptyAudioRecord();
  draft.segments = [];
  draft.cleanup_pending = {
    type: "voice_draft_cleanup_pending",
    revision: STATE_MACHINE_REVISION,
    mode: input.mode,
    at: input.at,
    actor: clone(input.actor),
    receipt_id: cleanToken(input.receiptId, DEFAULT_MAX_RECEIPT_LENGTH),
    files: [CANONICAL_AUDIO_FILE, JOURNAL_FILE],
  };
  draft.tombstone = {
    type: "voice_draft_tombstone",
    revision: STATE_MACHINE_REVISION,
    mode: input.mode,
    at: input.at,
    actor: clone(input.actor),
    receipt_id: cleanToken(input.receiptId, DEFAULT_MAX_RECEIPT_LENGTH),
    audio_bytes_discarded: priorAudio.total_bytes || 0,
    duration_ms_discarded: priorAudio.total_duration_ms || 0,
    segment_count_discarded: priorAudio.segment_count || 0,
  };
}

function completeCleanupPending(draftsDir, draft, limits) {
  const pending = draft.cleanup_pending;
  if (!pending) {
    return;
  }
  assertDraftBoundary(draftsDir, draft.id, "voice draft cleanup");
  assertKnownDraftDirectoryScaffolding(draftsDir, draft.id, "voice draft cleanup");
  const persistedBeforeCleanup = loadRequiredDraft(draftsDir, draft.id, limits);
  if (!isDeepStrictEqual(persistedBeforeCleanup, draft)) {
    throw statusError(500, `voice draft ${draft.id} cleanup authority changed before deletion`);
  }
  for (const relativePath of pending.files || []) {
    const filePath = safeChildPath(draftDirForId(draftsDir, draft.id), relativePath, "cleanup file");
    removeRegularFileVerified(filePath, `voice draft cleanup ${relativePath}`);
  }
  removeAtomicWriteTemps(draftDirForId(draftsDir, draft.id));
  assertContentArtifactsAbsent(draftsDir, draft.id);
  const persistedBeforeFinalize = loadRequiredDraft(draftsDir, draft.id, limits);
  if (!isDeepStrictEqual(persistedBeforeFinalize, draft)) {
    throw statusError(500, `voice draft ${draft.id} cleanup authority changed before finalization`);
  }
  draft.cleanup_pending = null;
  writeDraftRecord(draftsDir, draft, limits);
}

function emptyAudioRecord() {
  return {
    path: CANONICAL_AUDIO_FILE,
    content_type: "",
    encoding: "",
    total_bytes: 0,
    total_duration_ms: 0,
    segment_count: 0,
    sha256: "",
  };
}

function draftDirForId(draftsDir, draftId) {
  const safeId = requireExactToken(draftId, "draft_id", DEFAULT_MAX_CORRELATION_LENGTH, 404);
  return path.join(draftsDir, safeId);
}

function canonicalAudioPath(draftsDir, draftId) {
  return safeChildPath(draftDirForId(draftsDir, draftId), CANONICAL_AUDIO_FILE, "voice draft audio");
}

function journalPathForDraft(draftsDir, draftId) {
  return safeChildPath(draftDirForId(draftsDir, draftId), JOURNAL_FILE, "voice draft journal");
}

function metadataPathForDraft(draftsDir, draftId) {
  return safeChildPath(draftDirForId(draftsDir, draftId), META_FILE, "voice draft metadata");
}

function assertStoreBoundary(draftsDir) {
  const stat = assertDirectoryBoundary(draftsDir, "voice draft store");
  let realPath;
  try {
    realPath = fs.realpathSync(draftsDir);
  } catch (error) {
    throw statusError(500, `voice draft store could not be resolved: ${error.message}`);
  }
  return { stat, realPath };
}

function assertDraftBoundary(draftsDir, draftId, label = "voice draft directory") {
  const safeId = requireExactToken(draftId, "draft_id", DEFAULT_MAX_CORRELATION_LENGTH, 404);
  const store = assertStoreBoundary(draftsDir);
  const draftDir = draftDirForId(draftsDir, safeId);
  const stat = assertDirectoryBoundary(draftDir, label);
  let realPath;
  try {
    realPath = fs.realpathSync(draftDir);
  } catch (error) {
    throw statusError(500, `${label} could not be resolved: ${error.message}`);
  }
  const expectedRealPath = path.join(store.realPath, safeId);
  if (path.normalize(realPath) !== path.normalize(expectedRealPath)) {
    throw statusError(500, `${label} resolves outside the voice draft store`);
  }
  return {
    storeStat: store.stat,
    storeRealPath: store.realPath,
    draftStat: stat,
    draftRealPath: realPath,
  };
}

function assertSameBoundary(before, after, label) {
  const beforeStoreRealPath = before?.storeRealPath || before?.realPath;
  const afterStoreRealPath = after?.storeRealPath || after?.realPath;
  if (
    !before
    || !after
    || !sameFileIdentity(before.storeStat || before.stat, after.storeStat || after.stat)
    || (before.draftStat && !sameFileIdentity(before.draftStat, after.draftStat))
    || beforeStoreRealPath !== afterStoreRealPath
    || before.draftRealPath !== after.draftRealPath
  ) {
    throw statusError(500, `${label} directory boundary changed during filesystem access`);
  }
}

function ensurePrivateDraftDirectory(draftsDir, draftId) {
  const safeId = requireExactToken(draftId, "draft_id", DEFAULT_MAX_CORRELATION_LENGTH, 404);
  const storeBefore = assertStoreBoundary(draftsDir);
  const draftDir = draftDirForId(draftsDir, safeId);
  if (!pathEntryExists(draftDir)) {
    try {
      fs.mkdirSync(draftDir, { mode: 0o700 });
      fsyncDirectory(draftsDir, "voice draft store");
    } catch (error) {
      throw statusError(500, `voice draft directory could not be created safely: ${error.message}`);
    }
  }
  const boundary = assertDraftBoundary(draftsDir, safeId, "voice draft directory");
  assertSameBoundary(storeBefore, {
    stat: boundary.storeStat,
    realPath: boundary.storeRealPath,
  }, "voice draft store");
  try {
    fs.chmodSync(draftDir, 0o700);
  } catch (error) {
    throw statusError(500, `voice draft directory permissions could not be restricted: ${error.message}`);
  }
  return boundary;
}

function readDraftJsonFile(draftsDir, draftId, filePath, label, maxBytes) {
  return readJsonFile(
    filePath,
    label,
    maxBytes,
    () => assertDraftBoundary(draftsDir, draftId, `${label} directory`),
  );
}

function writeDraftJsonAtomic(draftsDir, draftId, fileName, value, limits, label) {
  const draftDir = draftDirForId(draftsDir, draftId);
  const filePath = safeChildPath(draftDir, fileName, label);
  return writeJsonAtomic(
    filePath,
    value,
    limits.maxMetadataBytes,
    () => assertDraftBoundary(draftsDir, draftId, `${label} directory`),
    limits.testHooks,
    label,
  );
}

function openDraftFile(draftsDir, draftId, filePath, flags, label, mode, expectedBoundary = null) {
  const before = assertDraftBoundary(draftsDir, draftId, `${label} directory`);
  if (expectedBoundary) {
    assertSameBoundary(expectedBoundary, before, label);
  }
  const fd = openRegularFile(filePath, flags, label, mode);
  try {
    const after = assertDraftBoundary(draftsDir, draftId, `${label} directory`);
    assertSameBoundary(before, after, label);
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function writeDraftRecord(draftsDir, draft, limits) {
  const filePath = metadataPathForDraft(draftsDir, draft.id);
  ensurePrivateDraftDirectory(draftsDir, draft.id);
  return writeDraftJsonAtomic(draftsDir, draft.id, META_FILE, draft, limits, "voice draft metadata");
}

function isVerifiedAmbiguousDraftPublication(error, draftsDir, draft, limits) {
  if (
    error?.code !== "voice_draft_publication_durability_unknown"
    || error?.publication_state !== "publication_durability_unknown"
    || error?.published_value_verified !== true
  ) {
    return false;
  }
  try {
    const persisted = readDraftJsonFile(
      draftsDir,
      draft.id,
      metadataPathForDraft(draftsDir, draft.id),
      `voice draft ${draft.id} ambiguous publication reconciliation`,
      limits.maxMetadataBytes,
    );
    return sameJson(persisted, draft);
  } catch {
    return false;
  }
}

function loadRequiredDraft(draftsDir, draftId, limits) {
  const draft = loadOptionalDraft(draftsDir, draftId, limits);
  if (!draft) {
    throw statusError(404, "voice draft not found");
  }
  return draft;
}

function loadOptionalDraft(draftsDir, draftId, limits) {
  const record = loadOptionalRecord(draftsDir, draftId, limits);
  if (record?.kind === EXPIRED_REPLAY_KIND) {
    throw expiredReplayError(record);
  }
  return record;
}

function loadRequiredRecord(draftsDir, draftId, limits) {
  const record = loadOptionalRecord(draftsDir, draftId, limits);
  if (!record) {
    throw statusError(404, "voice draft not found");
  }
  return record;
}

function loadOptionalRecord(draftsDir, draftId, limits, options = {}) {
  if (draftId === undefined || draftId === null || draftId === "") return null;
  const safeId = requireExactToken(draftId, "draft_id", DEFAULT_MAX_CORRELATION_LENGTH, 404);
  assertStoreBoundary(draftsDir);
  const draftDir = draftDirForId(draftsDir, safeId);
  if (!pathEntryExists(draftDir)) {
    return findExpiredReplayByDraft(draftsDir, safeId, limits);
  }
  assertDraftBoundary(draftsDir, safeId, "voice draft metadata read");
  const filePath = metadataPathForDraft(draftsDir, safeId);
  if (!pathEntryExists(filePath)) {
    return findExpiredReplayByDraft(draftsDir, safeId, limits);
  }
  const stored = readDraftJsonFile(
    draftsDir,
    safeId,
    filePath,
    `voice draft metadata for ${safeId}`,
    limits.maxMetadataBytes,
  );
  if (stored?.kind === EXPIRED_REPLAY_KIND) {
    const expired = normalizeStoredExpiredReplay(stored, safeId, limits);
    if (!options.skipPhysicalValidation) assertExactDraftDirectory(draftsDir, expired);
    return expired;
  }
  const draft = normalizeStoredDraft(stored, safeId, limits);
  if (!options.skipPhysicalValidation) {
    assertTerminalContentState(draftsDir, draft);
    assertExactDraftDirectory(draftsDir, draft);
  }
  return draft;
}

function expiredReplayError(record) {
  const error = statusError(410, `voice draft ${record.draft_id} replay authority expired from the full record`);
  error.code = "voice_draft_replay_expired";
  error.outcome = clone(record);
  return error;
}

function normalizeStoredDraft(draft, expectedId, limits) {
  if (!isPlainObject(draft) || draft.kind !== STORE_KIND) {
    throw statusError(500, "invalid voice draft metadata");
  }
  assertNoUnknownStoredFields(draft, STORED_DRAFT_FIELDS, "draft");
  if (draft.store_revision !== STORE_REVISION) {
    throw statusError(500, `voice draft store revision ${String(draft.store_revision)} is incompatible with ${STORE_REVISION}`);
  }
  if (draft.state_machine_revision !== STATE_MACHINE_REVISION) {
    throw statusError(
      500,
      `voice draft state-machine revision ${String(draft.state_machine_revision)} is incompatible with ${STATE_MACHINE_REVISION}`,
    );
  }
  if (typeof draft.state !== "string" || !Object.prototype.hasOwnProperty.call(LEGAL_TRANSITIONS, draft.state)) {
    throw statusError(500, `voice draft persisted state ${String(draft.state)} is invalid`);
  }
  const storedId = requireStoredAuthorityToken(draft.id, "id");
  if (storedId !== expectedId) {
    throw statusError(500, `voice draft persisted id ${storedId} disagrees with directory ${expectedId}`);
  }
  const normalized = {
    kind: draft.kind,
    store_revision: draft.store_revision,
    state_machine_revision: draft.state_machine_revision,
    state: draft.state,
    id: storedId,
    session_id: requireStoredAuthorityToken(draft.session_id, "session_id"),
    branch_id: requireStoredAuthorityToken(draft.branch_id, "branch_id"),
    source: requireStoredOptionalAuthorityToken(draft.source, "source"),
    surface: requireStoredOptionalAuthorityToken(draft.surface, "surface"),
    source_session_id: requireStoredOptionalAuthorityToken(draft.source_session_id, "source_session_id"),
    parent_intent_id: requireStoredOptionalAuthorityToken(draft.parent_intent_id, "parent_intent_id"),
    release_id: requireStoredOptionalAuthorityToken(draft.release_id, "release_id"),
    release_version: requireStoredOptionalAuthorityToken(draft.release_version, "release_version"),
    context_action: requireStoredOptionalAuthorityToken(draft.context_action, "context_action"),
    revision: requireStoredPositiveInteger(draft.revision, "revision"),
    created_at: requireStoredTimestamp(draft.created_at, "created_at"),
    updated_at: requireStoredTimestamp(draft.updated_at, "updated_at"),
    state_updated_at: requireStoredTimestamp(draft.state_updated_at, "state_updated_at"),
    resumed_at: requireStoredOptionalTimestamp(draft.resumed_at, "resumed_at"),
    resume_count: requireStoredNonNegativeInteger(draft.resume_count, "resume_count"),
    partial_transcript: requireStoredBoundedText(
      draft.partial_transcript,
      "partial_transcript",
      limits.maxPartialTranscriptChars,
    ),
    partial_transcript_updated_at: requireStoredTimestamp(
      draft.partial_transcript_updated_at,
      "partial_transcript_updated_at",
    ),
    audio: normalizeStoredAudio(draft.audio, limits),
    segments: normalizeSegments(draft.segments, limits),
    transition_history: normalizeStoredTransitionHistory(draft.transition_history, draft.id, limits),
    used_action_key_hashes: normalizeStoredActionKeyHashes(draft.used_action_key_hashes, draft.state, limits),
    capture_lease: normalizeStoredCaptureLease(draft.capture_lease, draft.id),
    create_request: normalizeStoredCreateRequest(draft.create_request, draft),
    mutation_anchor: normalizeStoredMutationAnchor(draft.mutation_anchor),
    authority_chain: normalizeStoredAuthorityChain(draft.authority_chain, draft.id, limits),
    cleanup_pending: normalizeStoredCleanupPending(draft.cleanup_pending),
    claim: normalizeStoredClaim(draft.claim, draft),
    claim_request: normalizeStoredClaimRequest(draft.claim_request, draft),
    sent_receipt: normalizeStoredSentReceipt(draft.sent_receipt, draft),
    sent_request: normalizeStoredSentRequest(draft.sent_request, draft),
    send_ready_receipt: normalizeStoredSendReadyReceipt(draft.send_ready_receipt),
    discard_receipt: normalizeStoredDiscardReceipt(draft.discard_receipt),
    parked_receipt: normalizeStoredParkedReceipt(draft.parked_receipt),
    recovery_receipt: normalizeStoredRecoveryReceipt(draft.recovery_receipt),
    tombstone: normalizeStoredTombstone(draft.tombstone, limits),
  };
  assertAllStoredFieldsPresent(draft, STORED_DRAFT_FIELDS, "draft");
  for (const field of [
    "session_id",
    "branch_id",
    "source",
    "surface",
    "source_session_id",
    "parent_intent_id",
    "release_id",
    "release_version",
    "context_action",
  ]) {
    if (normalized.create_request[field] !== normalized[field]) {
      throw statusError(500, `voice draft persisted create request disagrees with ${field}`);
    }
  }
  if (normalized.claim && normalized.claim_request) {
    for (const field of ["session_id", "branch_id", "turn_id"]) {
      if (normalized.claim[field] !== normalized.claim_request[field]) {
        throw statusError(500, `voice draft persisted claim request disagrees with ${field}`);
      }
    }
  }
  if (Boolean(normalized.claim) !== Boolean(normalized.claim_request)) {
    throw statusError(500, "voice draft persisted claim is missing its canonical request");
  }
  if (normalized.sent_receipt && normalized.sent_request) {
    assertStoredSentRequestReceiptMatch(normalized.sent_request, normalized.sent_receipt);
  }
  if (Boolean(normalized.sent_receipt) !== Boolean(normalized.sent_request)) {
    throw statusError(500, "voice draft persisted sent receipt is missing its canonical request");
  }
  for (const entry of normalized.transition_history) {
    const recoveryHash = normalized.recovery_receipt
      ? hashIdempotencyKey(normalized.recovery_receipt.idempotency_key)
      : "";
    if (
      !normalized.used_action_key_hashes.includes(entry.idempotency_key_hash)
      && entry.idempotency_key_hash !== recoveryHash
    ) {
      throw statusError(500, "voice draft persisted transition history is missing its durable action hash");
    }
    if (entry.request.expected_revision >= normalized.revision) {
      throw statusError(500, "voice draft persisted transition history revision exceeds the draft revision");
    }
  }
  validateStoredDraftBounds(normalized, limits);
  validateStoredStateInvariants(normalized);
  validateStoredMutationChain(normalized);
  validateStoredAuthorityChain(normalized, limits);
  return normalized;
}

function normalizeStoredAudio(audio, limits) {
  if (!isPlainObject(audio)) {
    throw statusError(500, "voice draft persisted audio record is invalid");
  }
  assertExactStoredFields(
    audio,
    ["path", "content_type", "encoding", "total_bytes", "total_duration_ms", "segment_count", "sha256"],
    "audio",
  );
  const record = {
    path: requireStoredText(audio.path, "audio.path"),
    content_type: requireStoredText(audio.content_type, "audio.content_type"),
    encoding: requireStoredText(audio.encoding, "audio.encoding"),
    total_bytes: requireStoredNonNegativeInteger(audio.total_bytes, "audio.total_bytes"),
    total_duration_ms: requireStoredNonNegativeInteger(audio.total_duration_ms, "audio.total_duration_ms"),
    segment_count: requireStoredNonNegativeInteger(audio.segment_count, "audio.segment_count"),
    sha256: requireStoredDigest(audio.sha256, "audio.sha256", true),
  };
  if (record.path !== CANONICAL_AUDIO_FILE) {
    throw statusError(500, `voice draft has unsafe persisted path ${record.path}`);
  }
  if (!record.content_type) {
    if (
      record.encoding
      || record.total_bytes !== 0
      || record.total_duration_ms !== 0
      || record.segment_count !== 0
      || record.sha256
    ) {
      throw statusError(500, "voice draft empty audio metadata is internally inconsistent");
    }
    return record;
  }
  if (record.content_type !== CANONICAL_CONTENT_TYPE || record.encoding !== CANONICAL_ENCODING) {
    throw statusError(500, "voice draft persisted audio is not canonical PCM16 mono 16kHz");
  }
  if (!record.sha256) {
    throw statusError(500, "voice draft persisted audio digest is required when audio is present");
  }
  if (
    record.total_bytes > limits.maxDraftBytes
    || record.total_duration_ms > limits.maxDraftDurationMs
    || record.segment_count > limits.maxSegmentsPerDraft
  ) {
    throw statusError(500, "voice draft persisted audio totals exceed configured limits");
  }
  return record;
}

function normalizeSegments(value, limits) {
  if (!Array.isArray(value)) {
    throw statusError(500, "voice draft persisted segments must be an array");
  }
  if (value.length > limits.maxSegmentsPerDraft) {
    throw statusError(500, "voice draft persisted segment count exceeds configured limits");
  }
  return value.map((segment) => {
    if (!isPlainObject(segment)) {
      throw statusError(500, "voice draft segment metadata is invalid");
    }
    assertExactStoredFields(segment, [
      "segment_id",
      "ordinal",
      "offset",
      "content_type",
      "encoding",
      "bytes",
      "duration_ms",
      "sha256",
      "created_at",
      "append_request",
    ], "segment");
    const normalized = {
      segment_id: requireStoredAuthorityToken(segment.segment_id, "segment_id"),
      ordinal: requireStoredPositiveInteger(segment.ordinal, "segment.ordinal"),
      offset: requireStoredNonNegativeInteger(segment.offset, "segment.offset"),
      content_type: requireStoredText(segment.content_type, "segment.content_type"),
      encoding: requireStoredText(segment.encoding, "segment.encoding"),
      bytes: requireStoredPositiveInteger(segment.bytes, "segment.bytes"),
      duration_ms: requireStoredNonNegativeInteger(segment.duration_ms, "segment.duration_ms"),
      sha256: requireStoredDigest(segment.sha256, "segment.sha256", false),
      created_at: requireStoredTimestamp(segment.created_at, "segment.created_at"),
      append_request: storedRequiredObject(segment.append_request, "segment.append_request"),
    };
    if (normalized.content_type !== CANONICAL_CONTENT_TYPE || normalized.encoding !== CANONICAL_ENCODING) {
      throw statusError(500, "voice draft segment metadata is not canonical PCM");
    }
    if (
      normalized.bytes > limits.maxSegmentBytes
      || normalized.duration_ms > limits.maxSegmentDurationMs
    ) {
      throw statusError(500, "voice draft persisted segment exceeds configured limits");
    }
    normalized.append_request = normalizeStoredAppendRequest(
      normalized.append_request,
      normalized,
    );
    return normalized;
  });
}

function validatePersistedAudio(draftsDir, draft, limits) {
  assertDraftBoundary(draftsDir, draft.id, "voice draft audio validation");
  const segmentIds = new Set();
  const totalSegmentBytes = draft.segments.reduce((sum, segment) => sum + segment.bytes, 0);
  const totalSegmentDuration = draft.segments.reduce((sum, segment) => sum + segment.duration_ms, 0);
  if (draft.audio.segment_count !== draft.segments.length) {
    throw statusError(500, `voice draft ${draft.id} segment count does not match metadata`);
  }
  if (draft.audio.total_bytes !== totalSegmentBytes || draft.audio.total_duration_ms !== totalSegmentDuration) {
    throw statusError(500, `voice draft ${draft.id} audio totals do not match segment metadata`);
  }
  let expectedOffset = 0;
  for (let index = 0; index < draft.segments.length; index += 1) {
    const segment = draft.segments[index];
    if (segmentIds.has(segment.segment_id)) {
      throw statusError(500, `voice draft ${draft.id} has duplicate segment ${segment.segment_id}`);
    }
    segmentIds.add(segment.segment_id);
    validateStoredAppendRequest(segment.append_request, draft.id, segment);
    if (segment.ordinal !== index + 1) {
      throw statusError(500, `voice draft ${draft.id} segment ordinals are not contiguous`);
    }
    if (segment.offset !== expectedOffset) {
      throw statusError(500, `voice draft ${draft.id} segment offsets are not contiguous`);
    }
    if (segment.bytes % 2 !== 0) {
      throw statusError(500, `voice draft ${draft.id} has odd-byte PCM metadata`);
    }
    expectedOffset += segment.bytes;
  }
  const audioPath = canonicalAudioPath(draftsDir, draft.id);
  if (draft.audio.total_bytes === 0) {
    if (pathEntryExists(audioPath)) {
      assertRegularFile(audioPath, `voice draft ${draft.id} untracked audio`);
      throw statusError(500, `voice draft ${draft.id} has an untracked audio file`);
    }
    return;
  }
  if (!pathEntryExists(audioPath)) {
    throw statusError(500, `voice draft ${draft.id} audio file is missing`);
  }
  assertRegularFile(audioPath, `voice draft ${draft.id} audio`);
  const stat = fs.lstatSync(audioPath);
  if (stat.size !== draft.audio.total_bytes) {
    throw statusError(500, `voice draft ${draft.id} PCM size mismatch`);
  }
  if (stat.size % 2 !== 0) {
    throw statusError(500, `voice draft ${draft.id} PCM byte length must be even`);
  }
  if (
    draft.audio.total_bytes > limits.maxDraftBytes
    || draft.audio.total_duration_ms > limits.maxDraftDurationMs
    || draft.audio.segment_count > limits.maxSegmentsPerDraft
  ) {
    throw statusError(500, `voice draft ${draft.id} audio exceeds configured limits`);
  }
  const fd = openDraftFile(
    draftsDir,
    draft.id,
    audioPath,
    fs.constants.O_RDONLY,
    `voice draft ${draft.id} segment digest validation`,
  );
  try {
    for (const segment of draft.segments) {
      if (digestFdRange(fd, segment.offset, segment.bytes) !== segment.sha256) {
        throw statusError(500, `voice draft ${draft.id} segment ${segment.segment_id} PCM digest mismatch`);
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  const digest = digestDraftFile(draftsDir, draft.id, audioPath, `voice draft ${draft.id} audio`);
  if (digest !== draft.audio.sha256) {
    throw statusError(500, `voice draft ${draft.id} PCM digest mismatch`);
  }
}

function assertTerminalContentState(draftsDir, draft) {
  if (!TERMINAL_STATES.has(draft.state) || draft.cleanup_pending) {
    return;
  }
  assertDraftBoundary(draftsDir, draft.id, "terminal voice draft directory");
  assertContentArtifactsAbsent(draftsDir, draft.id);
}

function currentTotalBytes(draftsDir, limits) {
  return listAuthoritativeDraftIds(draftsDir)
    .map((draftId) => loadOptionalRecord(draftsDir, draftId, limits))
    .filter(Boolean)
    .filter((record) => record.kind === STORE_KIND)
    .reduce(
      (sum, draft) => safeStoredSum(sum, accountedDraftBytes(draftsDir, draft, limits), "store bytes"),
      0,
    );
}

function currentDraftMetadataBytes(draftsDir) {
  return listAuthoritativeDraftIds(draftsDir).reduce((sum, draftId) => {
    const stat = assertRegularFile(
      metadataPathForDraft(draftsDir, draftId),
      `voice draft ${draftId} metadata accounting`,
    );
    return safeStoredSum(sum, stat.size, "metadata bytes");
  }, 0);
}

function countCapacityDrafts(draftsDir, limits) {
  return listAuthoritativeDraftIds(draftsDir)
    .map((draftId) => loadRequiredRecord(draftsDir, draftId, limits))
    .filter((record) => record.kind === STORE_KIND)
    .filter((draft) => !isTerminalReplayDraft(draft))
    .length;
}

function countTerminalReplayDrafts(draftsDir, limits) {
  return listAuthoritativeDraftIds(draftsDir)
    .map((draftId) => loadRequiredRecord(draftsDir, draftId, limits))
    .filter((record) => record.kind === STORE_KIND)
    .filter(isTerminalReplayDraft)
    .length;
}

function isTerminalReplayDraft(draft) {
  return TERMINAL_STATES.has(draft.state)
    && !draft.cleanup_pending
    && isEmptyStoredContent(draft);
}

function compactTerminalDrafts(draftsDir, limits, lockOptions) {
  let replayIndex = readReplayIndex(draftsDir, limits);
  const candidates = listAuthoritativeDraftIds(draftsDir)
    .map((draftId) => loadRequiredRecord(draftsDir, draftId, limits))
    .filter((record) => record.kind === STORE_KIND)
    .filter(isTerminalReplayDraft)
    .sort((left, right) => {
      const byTime = String(left.created_at).localeCompare(String(right.created_at));
      return byTime || left.id.localeCompare(right.id);
    });
  const removeCount = Math.max(0, candidates.length - limits.maxTerminalDrafts);
  const excessIds = new Set(candidates.slice(0, removeCount).map((candidate) => candidate.id));
  const selected = candidates.filter((candidate) => (
    excessIds.has(candidate.id) || Boolean(replayIndex.records_by_draft[candidate.id])
  ));
  for (const candidate of selected) {
    let expired;
    withDraftLock(draftsDir, candidate.id, lockOptions, () => {
      const current = loadRequiredDraft(draftsDir, candidate.id, limits);
      if (!isTerminalReplayDraft(current)) {
        throw statusError(500, `voice draft ${current.id} became ineligible for terminal retention compaction`);
      }
      validatePersistedAudio(draftsDir, current, limits);
      const boundaryBefore = assertDraftBoundary(draftsDir, current.id, "terminal replay compaction");
      const allowedFiles = new Set([META_FILE, DRAFT_LOCK_FILE]);
      const unexpected = fs.readdirSync(draftDirForId(draftsDir, current.id))
        .filter((name) => !allowedFiles.has(name));
      const boundaryAfter = assertDraftBoundary(draftsDir, current.id, "terminal replay compaction");
      assertSameBoundary(boundaryBefore, boundaryAfter, "terminal replay compaction");
      if (unexpected.length > 0) {
        throw statusError(
          500,
          `voice draft ${current.id} terminal replay contains unexpected files: ${unexpected.join(", ")}`,
        );
      }
      const indexed = replayIndex.records_by_draft[current.id] || null;
      if (indexed) {
        assertExpiredReplayMatchesDraft(indexed, current, limits);
        fsyncDirectory(draftsDir, "voice draft indexed replay authority confirmation");
        expired = indexed;
        return;
      }
      expired = normalizeStoredExpiredReplay(createExpiredReplayRecord(current), current.id, limits);
      replayIndex = addExpiredReplayToIndex(draftsDir, replayIndex, expired, limits);
    });
    runHook(lockOptions?.testHooks, "afterReplayIndexWriteBeforeDraftRemoval", {
      draftId: candidate.id,
    });
    removeCompactedDraftDirectory(draftsDir, candidate.id, expired, limits);
  }
}

function createExpiredReplayRecord(draft, expiredAt = new Date().toISOString()) {
  const action = draft.state === "sent" ? "mark_sent" : "discard";
  const terminalHistory = draft.transition_history.find(
    (entry) => entry.action === action
      && entry.idempotency_key_hash === hashIdempotencyKey(
        draft.state === "sent" ? draft.sent_receipt.receipt_id : draft.discard_receipt.idempotency_key,
      ),
  );
  if (!terminalHistory) {
    throw statusError(500, `voice draft ${draft.id} cannot compact without terminal replay history`);
  }
  const expired = {
    kind: EXPIRED_REPLAY_KIND,
    store_revision: STORE_REVISION,
    state_machine_revision: STATE_MACHINE_REVISION,
    draft_id: draft.id,
    state: "expired",
    terminal_state: draft.state,
    create_request: clone(draft.create_request),
    terminal_request: clone(draft.state === "sent" ? draft.sent_request : terminalHistory.request),
    terminal_receipt: clone(draft.state === "sent" ? draft.sent_receipt : draft.discard_receipt),
    terminal_history: clone(terminalHistory),
    claim: clone(draft.claim),
    claim_request: clone(draft.claim_request),
    final_revision: draft.revision,
    final_mutation_anchor: clone(draft.mutation_anchor),
    used_action_key_hashes: clone(draft.used_action_key_hashes),
    expired_at: expiredAt,
    decision_sha256: "",
  };
  expired.decision_sha256 = digestCanonicalValue(expiredReplayDecisionPayload(expired));
  return expired;
}

function assertExpiredReplayMatchesDraft(expired, draft, limits) {
  const expected = normalizeStoredExpiredReplay(
    createExpiredReplayRecord(draft, expired.expired_at),
    draft.id,
    limits,
  );
  if (!sameJson(expired, expected)) {
    throw statusError(500, `voice draft ${draft.id} compacted replay disagrees with full terminal authority`);
  }
}

function removeCompactedDraftDirectory(draftsDir, draftId, expired, limits) {
  const current = loadRequiredDraft(draftsDir, draftId, limits);
  assertExpiredReplayMatchesDraft(expired, current, limits);
  assertExactDraftDirectory(draftsDir, current);
  const draftDir = draftDirForId(draftsDir, draftId);
  removeRegularFileVerified(metadataPathForDraft(draftsDir, draftId), "compacted voice draft metadata");
  if (fs.readdirSync(draftDir).length !== 0) {
    throw statusError(500, `voice draft ${draftId} compaction left unexpected directory entries`);
  }
  removeEmptyDraftDirectory(draftsDir, draftId);
}

function normalizeStoredExpiredReplay(value, expectedId, limits) {
  if (!isPlainObject(value) || value.kind !== EXPIRED_REPLAY_KIND) {
    throw statusError(500, "invalid voice draft expired replay metadata");
  }
  assertExactStoredFields(value, EXPIRED_REPLAY_FIELDS, "expired_replay");
  if (
    value.store_revision !== STORE_REVISION
    || value.state_machine_revision !== STATE_MACHINE_REVISION
    || value.state !== "expired"
    || !TERMINAL_STATES.has(value.terminal_state)
  ) {
    throw statusError(500, "voice draft expired replay revision or state is incompatible");
  }
  const draftId = requireStoredAuthorityToken(value.draft_id, "expired_replay.draft_id");
  if (draftId !== expectedId) {
    throw statusError(500, `voice draft expired replay id ${draftId} disagrees with directory ${expectedId}`);
  }
  const createRequest = normalizeStoredCreateRequest(value.create_request, null);
  const authority = {
    id: draftId,
    session_id: createRequest.session_id,
    branch_id: createRequest.branch_id,
    source: createRequest.source,
    surface: createRequest.surface,
    release_id: createRequest.release_id,
    release_version: createRequest.release_version,
  };
  let terminalRequest;
  let terminalReceipt;
  let claim;
  let claimRequest;
  const finalRevision = requireStoredPositiveInteger(
    value.final_revision,
    "expired_replay.final_revision",
  );
  const finalMutationAnchor = normalizeStoredMutationAnchor(value.final_mutation_anchor);
  const terminalHistory = normalizeStoredTransitionHistory(
    [value.terminal_history],
    draftId,
    { ...limits, maxTransitionHistory: Math.max(1, limits.maxTransitionHistory) },
  )[0];
  if (value.terminal_state === "sent") {
    terminalRequest = normalizeStoredSentRequest(value.terminal_request, authority);
    terminalReceipt = normalizeStoredSentReceipt(value.terminal_receipt, authority);
    assertStoredSentRequestReceiptMatch(terminalRequest, terminalReceipt);
    claim = normalizeStoredClaim(value.claim, authority);
    claimRequest = normalizeStoredClaimRequest(value.claim_request, authority);
    if (!claim || !claimRequest) {
      throw statusError(500, "voice draft expired sent replay is missing claim authority");
    }
    for (const field of ["session_id", "branch_id", "turn_id"]) {
      if (
        claim[field] !== claimRequest[field]
        || claim[field] !== terminalReceipt[field]
      ) {
        throw statusError(500, `voice draft expired sent claim disagrees with ${field}`);
      }
    }
    if (claimRequest.expected_revision + 1 !== terminalRequest.expected_revision) {
      throw statusError(500, "voice draft expired sent claim revision authority is contradictory");
    }
  } else {
    terminalRequest = normalizeStoredHistoryRequest(value.terminal_request, draftId, "discard");
    terminalReceipt = normalizeStoredDiscardReceipt(value.terminal_receipt);
    if (value.claim !== null || value.claim_request !== null) {
      throw statusError(500, "voice draft expired discarded replay cannot contain claim authority");
    }
    claim = null;
    claimRequest = null;
    if (
      terminalRequest.idempotency_key !== terminalReceipt.idempotency_key
      || !sameJson(terminalRequest.actor, terminalReceipt.actor)
    ) {
      throw statusError(500, "voice draft expired discard replay authority disagrees");
    }
  }
  const hashes = normalizeStoredActionKeyHashes(value.used_action_key_hashes, value.terminal_state, limits);
  if (!hashes.includes(hashIdempotencyKey(terminalRequest.idempotency_key))) {
    throw statusError(500, "voice draft expired replay is missing terminal action authority");
  }
  if (
    terminalHistory.action !== (value.terminal_state === "sent" ? "mark_sent" : "discard")
    || !sameJson(terminalHistory.request, terminalRequest)
    || terminalHistory.receipt.idempotency_key !== terminalRequest.idempotency_key
    || !sameJson(terminalHistory.receipt.actor, terminalRequest.actor)
    || terminalHistory.receipt.state_after !== value.terminal_state
  ) {
    throw statusError(500, "voice draft expired replay terminal history authority disagrees");
  }
  const terminalAt = value.terminal_state === "sent" ? terminalReceipt.sent_at : terminalReceipt.at;
  if (terminalHistory.receipt.at !== terminalAt) {
    throw statusError(500, "voice draft expired replay terminal timestamp authority disagrees");
  }
  if (
    terminalRequest.expected_revision + 1 !== finalRevision
    || finalMutationAnchor.mutation !== "transition"
    || finalMutationAnchor.previous_revision !== terminalRequest.expected_revision
    || finalMutationAnchor.draft_revision !== finalRevision
    || finalMutationAnchor.state !== value.terminal_state
    || finalMutationAnchor.at !== terminalAt
    || finalMutationAnchor.request_sha256 !== digestCanonicalValue(terminalRequest)
  ) {
    throw statusError(500, "voice draft expired replay final mutation authority is contradictory");
  }
  const expiredAt = requireStoredTimestamp(value.expired_at, "expired_replay.expired_at");
  const normalized = {
    kind: value.kind,
    store_revision: value.store_revision,
    state_machine_revision: value.state_machine_revision,
    draft_id: draftId,
    state: value.state,
    terminal_state: value.terminal_state,
    create_request: createRequest,
    terminal_request: terminalRequest,
    terminal_receipt: terminalReceipt,
    terminal_history: terminalHistory,
    claim,
    claim_request: claimRequest,
    final_revision: finalRevision,
    final_mutation_anchor: finalMutationAnchor,
    used_action_key_hashes: hashes,
    expired_at: expiredAt,
    decision_sha256: requireStoredDigest(
      value.decision_sha256,
      "expired_replay.decision_sha256",
      false,
    ),
  };
  if (normalized.decision_sha256 !== digestCanonicalValue(expiredReplayDecisionPayload(normalized))) {
    throw statusError(500, "voice draft expired replay decision digest disagrees");
  }
  return normalized;
}

function expiredReplayDecisionPayload(record) {
  return {
    kind: record.kind,
    store_revision: record.store_revision,
    state_machine_revision: record.state_machine_revision,
    draft_id: record.draft_id,
    state: record.state,
    terminal_state: record.terminal_state,
    create_request: clone(record.create_request),
    terminal_request: clone(record.terminal_request),
    terminal_receipt: clone(record.terminal_receipt),
    terminal_history: clone(record.terminal_history),
    claim: clone(record.claim),
    claim_request: clone(record.claim_request),
    final_revision: record.final_revision,
    final_mutation_anchor: clone(record.final_mutation_anchor),
    used_action_key_hashes: clone(record.used_action_key_hashes),
    expired_at: record.expired_at,
  };
}

function replayIndexPath(draftsDir) {
  return path.join(draftsDir, REPLAY_INDEX_FILE);
}

function emptyReplayIndex() {
  return {
    kind: "voice_draft_expired_replay_index",
    store_revision: STORE_REVISION,
    state_machine_revision: STATE_MACHINE_REVISION,
    revision: 1,
    records_by_draft: Object.create(null),
    draft_by_create_hash: Object.create(null),
  };
}

function readReplayIndex(draftsDir, limits) {
  const filePath = replayIndexPath(draftsDir);
  if (!pathEntryExists(filePath)) return emptyReplayIndex();
  const value = readJsonFile(
    filePath,
    "voice draft expired replay index",
    limits.maxReplayIndexBytes,
    () => assertStoreBoundary(draftsDir),
  );
  return normalizeStoredReplayIndex(value, limits);
}

function normalizeStoredReplayIndex(value, limits) {
  if (!isPlainObject(value)) {
    throw statusError(500, "voice draft expired replay index is invalid");
  }
  assertExactStoredFields(value, REPLAY_INDEX_FIELDS, "expired_replay_index");
  if (
    value.kind !== "voice_draft_expired_replay_index"
    || value.store_revision !== STORE_REVISION
    || value.state_machine_revision !== STATE_MACHINE_REVISION
  ) {
    throw statusError(500, "voice draft expired replay index revision is incompatible");
  }
  if (!isPlainObject(value.records_by_draft) || !isPlainObject(value.draft_by_create_hash)) {
    throw statusError(500, "voice draft expired replay index maps are invalid");
  }
  const recordsByDraft = Object.create(null);
  const draftByCreateHash = Object.create(null);
  const recordEntries = Object.entries(value.records_by_draft);
  if (recordEntries.length > limits.maxExpiredReplayRecords) {
    throw statusError(500, "voice draft expired replay index exceeds configured record capacity");
  }
  for (const [draftId, rawRecord] of recordEntries) {
    const safeDraftId = requireStoredAuthorityToken(draftId, "expired_replay_index.draft_id");
    const record = normalizeStoredExpiredReplay(rawRecord, safeDraftId, limits);
    if (replayIndexEncodedBytes({ record }) > limits.expiredReplayRecordReservationBytes) {
      throw statusError(500, "voice draft expired replay index record exceeds its reserved byte capacity");
    }
    recordsByDraft[safeDraftId] = record;
  }
  const createEntries = Object.entries(value.draft_by_create_hash);
  if (createEntries.length !== recordEntries.length) {
    throw statusError(500, "voice draft expired replay index create map cardinality disagrees");
  }
  for (const [createHash, draftIdValue] of createEntries) {
    const hash = requireStoredDigest(createHash, "expired_replay_index.create_hash", false);
    const draftId = requireStoredAuthorityToken(
      draftIdValue,
      "expired_replay_index.create_draft_id",
    );
    const record = recordsByDraft[draftId];
    if (!record || hashIdempotencyKey(record.create_request.idempotency_key) !== hash) {
      throw statusError(500, "voice draft expired replay index create lookup authority disagrees");
    }
    draftByCreateHash[hash] = draftId;
  }
  for (const record of Object.values(recordsByDraft)) {
    const hash = hashIdempotencyKey(record.create_request.idempotency_key);
    if (draftByCreateHash[hash] !== record.draft_id) {
      throw statusError(500, "voice draft expired replay index is missing keyed create authority");
    }
  }
  return {
    kind: value.kind,
    store_revision: value.store_revision,
    state_machine_revision: value.state_machine_revision,
    revision: requireStoredPositiveInteger(value.revision, "expired_replay_index.revision"),
    records_by_draft: recordsByDraft,
    draft_by_create_hash: draftByCreateHash,
  };
}

function replayIndexEncodedBytes(index) {
  return Buffer.byteLength(`${JSON.stringify(index, null, 2)}\n`, "utf8");
}

function writeReplayIndex(draftsDir, index, limits) {
  const normalized = normalizeStoredReplayIndex(index, limits);
  const encodedBytes = replayIndexEncodedBytes(normalized);
  if (encodedBytes > limits.maxReplayIndexBytes) {
    throw statusError(507, "voice draft expired replay index byte capacity exceeded");
  }
  writeJsonAtomic(
    replayIndexPath(draftsDir),
    normalized,
    limits.maxReplayIndexBytes,
    () => assertStoreBoundary(draftsDir),
    limits.testHooks,
    "voice draft expired replay index",
  );
  return normalized;
}

function addExpiredReplayToIndex(draftsDir, index, record, limits) {
  const existing = index.records_by_draft[record.draft_id];
  if (existing) {
    if (!sameJson(existing, record)) {
      throw statusError(500, `voice draft ${record.draft_id} expired replay authority disagrees with its index`);
    }
    return index;
  }
  const createHash = hashIdempotencyKey(record.create_request.idempotency_key);
  const existingCreateDraft = index.draft_by_create_hash[createHash];
  if (existingCreateDraft && existingCreateDraft !== record.draft_id) {
    throw statusError(500, "voice draft expired replay create authority is duplicated");
  }
  const recordBytes = replayIndexEncodedBytes({ record });
  if (recordBytes > limits.expiredReplayRecordReservationBytes) {
    throw statusError(507, "voice draft expired replay record exceeds its reserved byte capacity");
  }
  if (Object.keys(index.records_by_draft).length >= limits.maxExpiredReplayRecords) {
    throw statusError(507, "voice draft expired replay record capacity exceeded");
  }
  const next = {
    ...index,
    revision: safeMutationSum(index.revision, 1, "expired replay index revision"),
    records_by_draft: Object.assign(Object.create(null), index.records_by_draft, {
      [record.draft_id]: clone(record),
    }),
    draft_by_create_hash: Object.assign(Object.create(null), index.draft_by_create_hash, {
      [createHash]: record.draft_id,
    }),
  };
  if (replayIndexEncodedBytes(next) > limits.maxReplayIndexBytes) {
    throw statusError(507, "voice draft expired replay index byte capacity exceeded");
  }
  return writeReplayIndex(draftsDir, next, limits);
}

function findExpiredReplayByDraft(draftsDir, draftId, limits, index = null) {
  const safeId = requireExactToken(draftId, "draft_id", DEFAULT_MAX_CORRELATION_LENGTH, 404);
  const replayIndex = index || readReplayIndex(draftsDir, limits);
  return replayIndex.records_by_draft[safeId] || null;
}

function findExpiredReplayByCreate(draftsDir, idempotencyKey, limits, index = null) {
  const replayIndex = index || readReplayIndex(draftsDir, limits);
  const draftId = replayIndex.draft_by_create_hash[hashIdempotencyKey(idempotencyKey)] || "";
  return draftId ? replayIndex.records_by_draft[draftId] || null : null;
}

function replayIndexMetadataBytes(draftsDir) {
  const filePath = replayIndexPath(draftsDir);
  if (!pathEntryExists(filePath)) return 0;
  return assertRegularFile(filePath, "voice draft expired replay index").size;
}

function assertReplayAdmissionAvailable(draftsDir, limits, additionalFullRecords = 1) {
  const index = readReplayIndex(draftsDir, limits);
  const fullRecordCount = listAuthoritativeDraftIds(draftsDir)
    .filter((draftId) => !index.records_by_draft[draftId])
    .length;
  const indexedCount = Object.keys(index.records_by_draft).length;
  const totalDecisionCapacity = safeMutationSum(
    limits.maxTerminalDrafts,
    limits.maxExpiredReplayRecords,
    "replay decision capacity",
  );
  if (safeMutationSum(fullRecordCount, indexedCount + additionalFullRecords, "replay decisions") > totalDecisionCapacity) {
    throw statusError(507, "voice draft replay authority capacity exceeded; new capture admission is paused");
  }
  const reservedBytes = replayIndexEncodedBytes(index)
    + ((fullRecordCount + additionalFullRecords) * limits.expiredReplayRecordReservationBytes);
  if (!Number.isSafeInteger(reservedBytes) || reservedBytes > limits.maxReplayIndexBytes) {
    throw statusError(507, "voice draft replay metadata byte capacity exceeded; new capture admission is paused");
  }
}

function accountedDraftBytes(draftsDir, draft, limits) {
  let accounted = draft.audio?.total_bytes || 0;
  if (draft.cleanup_pending) {
    accounted = Math.max(accounted, draft.tombstone?.audio_bytes_discarded || 0);
  }
  const journalPath = journalPathForDraft(draftsDir, draft.id);
  if (pathEntryExists(journalPath)) {
    const journal = normalizeStoredAppendJournal(
      readDraftJsonFile(
        draftsDir,
        draft.id,
        journalPath,
        "voice draft append journal",
        limits.maxMetadataBytes,
      ),
      draft,
      limits,
    );
    accounted = Math.max(accounted, journal.post.bytes);
  }
  const audioPath = canonicalAudioPath(draftsDir, draft.id);
  if (pathEntryExists(audioPath)) {
    accounted = Math.max(accounted, assertRegularFile(audioPath, "voice draft accounted audio").size);
  }
  return accounted;
}

function appendAudioBytes(draftsDir, draftId, audioPath, audioRecord, bytes) {
  assertDraftBoundary(draftsDir, draftId, "voice draft audio append");
  const createdAudioFile = !pathEntryExists(audioPath);
  const fd = openDraftFile(
    draftsDir,
    draftId,
    audioPath,
    fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_APPEND,
    "voice draft audio",
    0o600,
  );
  try {
    const stat = fs.fstatSync(fd);
    if (stat.size !== (audioRecord.total_bytes || 0)) {
      throw statusError(500, "voice draft audio file size does not match metadata before append");
    }
    if (stat.size > 0) {
      const currentDigest = digestFd(fd);
      if (currentDigest !== audioRecord.sha256) {
        throw statusError(500, "voice draft audio file digest does not match metadata before append");
      }
    }
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
      if (written <= 0) {
        throw statusError(500, "voice draft audio append made no progress");
      }
      offset += written;
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (createdAudioFile) {
    fsyncDirectory(path.dirname(audioPath), "voice draft audio directory");
  }
}

function clearJournal(draftsDir, draftId) {
  removeRegularFileVerified(journalPathForDraft(draftsDir, draftId), "voice draft append journal");
}

function readJsonFile(filePath, label, maxBytes, boundaryVerifier = null) {
  let fd;
  try {
    const beforeBoundary = boundaryVerifier ? boundaryVerifier() : null;
    fd = openRegularFile(filePath, fs.constants.O_RDONLY, label);
    const stat = fs.fstatSync(fd);
    if (!Number.isSafeInteger(stat.size) || stat.size > maxBytes) {
      throw statusError(500, `${label} exceeds ${maxBytes} bytes`);
    }
    const bytes = Buffer.alloc(stat.size + 1);
    const bytesRead = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (bytesRead > maxBytes || bytesRead !== stat.size) {
      throw statusError(500, `${label} changed or exceeds ${maxBytes} bytes while being read`);
    }
    if (boundaryVerifier) {
      const afterBoundary = boundaryVerifier();
      assertSameBoundary(beforeBoundary, afterBoundary, label);
    }
    const encoded = bytes.subarray(0, bytesRead).toString("utf8");
    assertNoDuplicateJsonObjectMembers(encoded, label);
    return JSON.parse(encoded);
  } catch (error) {
    throw statusError(500, `${label} is unreadable: ${error.message}`);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function assertNoDuplicateJsonObjectMembers(encoded, label) {
  let offset = 0;
  const skipWhitespace = () => {
    while (offset < encoded.length && /\s/.test(encoded[offset])) offset += 1;
  };
  const parseString = () => {
    if (encoded[offset] !== '"') throw new Error(`${label} contains an invalid JSON object key`);
    const start = offset;
    offset += 1;
    while (offset < encoded.length) {
      const char = encoded[offset];
      if (char === "\\") {
        offset += 2;
        continue;
      }
      offset += 1;
      if (char === '"') {
        return JSON.parse(encoded.slice(start, offset));
      }
    }
    throw new Error(`${label} contains an unterminated JSON string`);
  };
  const parseValue = (depth = 0) => {
    if (depth > 256) throw new Error(`${label} exceeds the maximum JSON nesting depth`);
    skipWhitespace();
    const char = encoded[offset];
    if (char === "{") {
      offset += 1;
      skipWhitespace();
      const keys = new Set();
      if (encoded[offset] === "}") {
        offset += 1;
        return;
      }
      while (offset < encoded.length) {
        skipWhitespace();
        const key = parseString();
        if (keys.has(key)) {
          throw new Error(`${label} contains duplicate JSON object member ${key}`);
        }
        keys.add(key);
        skipWhitespace();
        if (encoded[offset] !== ":") throw new Error(`${label} contains invalid JSON object syntax`);
        offset += 1;
        parseValue(depth + 1);
        skipWhitespace();
        if (encoded[offset] === "}") {
          offset += 1;
          return;
        }
        if (encoded[offset] !== ",") throw new Error(`${label} contains invalid JSON object syntax`);
        offset += 1;
      }
      throw new Error(`${label} contains an unterminated JSON object`);
    }
    if (char === "[") {
      offset += 1;
      skipWhitespace();
      if (encoded[offset] === "]") {
        offset += 1;
        return;
      }
      while (offset < encoded.length) {
        parseValue(depth + 1);
        skipWhitespace();
        if (encoded[offset] === "]") {
          offset += 1;
          return;
        }
        if (encoded[offset] !== ",") throw new Error(`${label} contains invalid JSON array syntax`);
        offset += 1;
      }
      throw new Error(`${label} contains an unterminated JSON array`);
    }
    if (char === '"') {
      parseString();
      return;
    }
    for (const literal of ["true", "false", "null"]) {
      if (encoded.startsWith(literal, offset)) {
        offset += literal.length;
        return;
      }
    }
    const number = encoded.slice(offset).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!number) throw new Error(`${label} contains an invalid JSON value`);
    offset += number[0].length;
  };
  parseValue();
  skipWhitespace();
  if (offset !== encoded.length) {
    throw new Error(`${label} contains trailing JSON data`);
  }
}

function writeJsonAtomic(
  filePath,
  value,
  maxBytes,
  boundaryVerifier = null,
  testHooks = null,
  label = "voice draft JSON",
) {
  const encoded = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(encoded, "utf8") > maxBytes) {
    throw statusError(507, `voice draft metadata exceeds ${maxBytes} bytes`);
  }
  return atomicWrite(filePath, encoded, boundaryVerifier, testHooks, label);
}

function withStoreLock(draftsDir, lockOptions, fn) {
  assertExactStoreRoot(draftsDir);
  return withFileLock(path.join(draftsDir, STORE_LOCK_FILE), "voice-draft-store", lockOptions, fn, () => (
    assertStoreBoundary(draftsDir)
  ));
}

function withMutableDraftLock(draftsDir, draftId, limits, lockOptions, fn) {
  const expired = findExpiredReplayByDraft(draftsDir, draftId, limits);
  if (expired) throw expiredReplayError(expired);
  return withDraftLock(draftsDir, draftId, lockOptions, fn);
}

function withDraftLock(draftsDir, draftId, lockOptions, fn) {
  const safeId = requireExactToken(draftId, "draft_id", DEFAULT_MAX_CORRELATION_LENGTH, 404);
  if (!pathEntryExists(draftDirForId(draftsDir, safeId))) {
    throw statusError(404, "voice draft not found");
  }
  assertDraftBoundary(draftsDir, safeId, `${safeId} lock`);
  return withFileLock(
    path.join(draftDirForId(draftsDir, safeId), DRAFT_LOCK_FILE),
    safeId,
    lockOptions,
    fn,
    () => assertDraftBoundary(draftsDir, safeId, `${safeId} lock`),
  );
}

function withFileLock(lockPath, label, lockOptions, fn, boundaryVerifier) {
  boundaryVerifier();
  const owner = {
    type: "voice_draft_operation_lock",
    owner_id: `owner_${crypto.randomBytes(12).toString("hex")}`,
    label,
    pid: process.pid,
    process_boot_id: PROCESS_BOOT_ID,
    acquired_at: new Date().toISOString(),
  };
  acquireOwnerFile(lockPath, owner, label, lockOptions);
  boundaryVerifier();
  try {
    return fn();
  } finally {
    try {
      runHook(lockOptions?.testHooks, "beforeLockRelease", { lockPath, label, owner: clone(owner) });
    } finally {
      boundaryVerifier();
      releaseOwnerFileIfOwned(lockPath, owner, `${label} lock`);
      boundaryVerifier();
    }
  }
}

function acquireOwnerFile(lockPath, owner, label, lockOptions) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      createOwnerFile(lockPath, owner, `${label} lock`);
      return;
    } catch (error) {
      if (!error || error.code !== "EEXIST") {
        throw error;
      }
    }
    const snapshot = readOwnerSnapshot(lockPath, `${label} lock`, lockOptions);
    if (snapshot.record && isLockOwnerLive(snapshot.record)) {
      throw statusError(409, `${label} is locked by another live operation`);
    }
    if (!snapshot.stale) {
      throw statusError(409, `${label} has a recent incomplete lock; retry after the stale interval`);
    }
    takeoverStaleOwnerFile(lockPath, snapshot, `${label} lock`);
  }
  throw statusError(409, `${label} lock contention did not settle`);
}

function createOwnerFile(filePath, owner, label) {
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | Number(fs.constants.O_NOFOLLOW || 0);
  let fd;
  try {
    fd = fs.openSync(filePath, flags, 0o600);
  } catch (error) {
    throw error;
  }
  const identity = fs.fstatSync(fd);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(owner)}\n`);
    fs.fsyncSync(fd);
  } catch (error) {
    unlinkIfIdentityMatches(filePath, identity, label);
    throw error;
  } finally {
    fs.closeSync(fd);
  }
  try {
    fsyncDirectory(path.dirname(filePath), `${label} directory`);
  } catch (durabilityError) {
    try {
      unlinkIfIdentityMatches(filePath, identity, `${label} uncommitted acquisition`);
    } catch (cleanupError) {
      const error = statusError(
        500,
        `${label} acquisition durability failed and exact-owner cleanup could not be confirmed: ${cleanupError.message}`,
      );
      error.code = "voice_draft_owner_acquisition_cleanup_failed";
      error.cause = durabilityError;
      throw error;
    }
    throw durabilityError;
  }
}

function readOwnerSnapshot(filePath, label, lockOptions = {}) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (error && error.code === "ENOENT") return { missing: true, stale: false, record: null };
    throw statusError(500, `${label} could not be inspected: ${error.message}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw statusError(500, `${label} must be a non-symlink regular file`);
  }
  let record = null;
  const fd = openRegularFile(filePath, fs.constants.O_RDONLY, label);
  let encoded = "";
  try {
    const openedStat = fs.fstatSync(fd);
    if (!sameFileIdentity(openedStat, stat)) {
      throw statusError(409, `${label} changed while being inspected`);
    }
    if (!Number.isSafeInteger(openedStat.size) || openedStat.size > MAX_OWNER_RECORD_BYTES) {
      throw statusError(500, `${label} exceeds ${MAX_OWNER_RECORD_BYTES} bytes`);
    }
    const bytes = Buffer.alloc(openedStat.size + 1);
    const bytesRead = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (bytesRead !== openedStat.size) {
      throw statusError(500, `${label} changed while being read`);
    }
    encoded = bytes.subarray(0, bytesRead).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
  try {
    record = JSON.parse(encoded);
  } catch {
    record = null;
  }
  const completeRecord = isCompleteOwnerRecord(record) ? record : null;
  const staleMs = positiveInt(lockOptions.staleMs, DEFAULT_LOCK_STALE_MS);
  const oldEnough = Date.now() - stat.mtimeMs >= staleMs;
  return {
    missing: false,
    stat,
    record: completeRecord,
    stale: completeRecord ? !isLockOwnerLive(completeRecord) : oldEnough,
  };
}

function isCompleteOwnerRecord(record) {
  if (!isPlainObject(record)) return false;
  const common = isExactToken(record.owner_id, DEFAULT_MAX_CORRELATION_LENGTH)
    && typeof record.pid === "number"
    && Number.isSafeInteger(record.pid)
    && record.pid > 0
    && isExactToken(record.process_boot_id, 80)
    && typeof record.acquired_at === "string"
    && normalizeTimestamp(record.acquired_at) === record.acquired_at;
  if (!common) return false;
  if (record.type === "voice_draft_operation_lock") {
    if (!hasExactFields(record, [
      "type",
      "owner_id",
      "label",
      "pid",
      "process_boot_id",
      "acquired_at",
    ])) return false;
    return isExactToken(record.label, DEFAULT_MAX_CORRELATION_LENGTH);
  }
  if (record.type === "voice_draft_capture_lease") {
    if (!hasExactFields(record, [
      "type",
      "owner_id",
      "draft_id",
      "lease_id",
      "pid",
      "process_boot_id",
      "acquired_at",
    ])) return false;
    return isExactToken(record.draft_id, DEFAULT_MAX_CORRELATION_LENGTH)
      && isExactToken(record.lease_id, DEFAULT_MAX_CORRELATION_LENGTH);
  }
  return false;
}

function takeoverStaleOwnerFile(filePath, snapshot, label) {
  if (!snapshot || snapshot.missing || !snapshot.stat) return false;
  let current;
  try {
    current = fs.lstatSync(filePath);
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
  if (!sameFileIdentity(current, snapshot.stat)) return false;
  const quarantine = `${filePath}.stale.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
  try {
    fs.renameSync(filePath, quarantine);
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw statusError(500, `${label} stale takeover failed: ${error.message}`);
  }
  const moved = fs.lstatSync(quarantine);
  if (!sameFileIdentity(moved, snapshot.stat)) {
    if (!pathEntryExists(filePath)) fs.renameSync(quarantine, filePath);
    throw statusError(409, `${label} changed owner during stale takeover`);
  }
  removeRegularFileVerified(quarantine, `${label} stale quarantine`);
  return true;
}

function releaseOwnerFileIfOwned(filePath, expectedOwner, label) {
  let snapshot;
  try {
    snapshot = readOwnerSnapshot(filePath, label);
  } catch (error) {
    if (error.statusCode === 500) throw error;
    return false;
  }
  if (snapshot.missing || !snapshot.record || snapshot.record.owner_id !== expectedOwner?.owner_id) {
    return false;
  }
  unlinkIfIdentityMatches(filePath, snapshot.stat, label);
  return true;
}

function unlinkIfIdentityMatches(filePath, expectedStat, label) {
  let current;
  try {
    current = fs.lstatSync(filePath);
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
  if (!sameFileIdentity(current, expectedStat)) return false;
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    throw statusError(500, `${label} could not be released: ${error.message}`);
  }
  fsyncDirectory(path.dirname(filePath), `${label} directory`);
  return true;
}

function sameFileIdentity(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

function acquireCaptureLease(draftsDir, input, lockOptions) {
  const now = normalizeTimestamp(input.at) || new Date().toISOString();
  const lockPath = path.join(draftsDir, CAPTURE_LOCK_FILE);
  const owner = {
    type: "voice_draft_capture_lease",
    owner_id: `owner_${crypto.randomBytes(12).toString("hex")}`,
    draft_id: requireExactToken(input.draft_id, "draft_id", DEFAULT_MAX_CORRELATION_LENGTH),
    lease_id: input.lease_id
      ? requireExactToken(input.lease_id, "capture_lease_id", DEFAULT_MAX_CORRELATION_LENGTH)
      : `lease_${crypto.randomBytes(8).toString("hex")}`,
    pid: process.pid,
    process_boot_id: PROCESS_BOOT_ID,
    acquired_at: now,
  };
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      createOwnerFile(lockPath, owner, "voice draft capture lease");
      return owner;
    } catch (error) {
      if (!error || error.code !== "EEXIST") {
        throw error;
      }
      const snapshot = readOwnerSnapshot(lockPath, "voice draft capture lease", lockOptions);
      if (snapshot.record && isLiveLeaseRecord(snapshot.record)) {
        throw statusError(409, `voice draft ${snapshot.record.draft_id} already holds the active capture lease`);
      }
      if (!snapshot.stale) {
        throw statusError(409, "voice draft capture lease is incomplete; retry after the stale interval");
      }
      takeoverStaleOwnerFile(lockPath, snapshot, "voice draft capture lease");
    }
  }
  throw statusError(409, "voice draft capture lease contention did not settle");
}

function assertCaptureLeaseMatches(draftsDir, draft) {
  const lease = readCaptureLeaseRecord(draftsDir);
  if (!lease || !isLiveLeaseRecord(lease) || !sameLeaseOwner(lease, draft.capture_lease)) {
    throw statusError(409, `voice draft ${draft.id} does not hold the active capture lease`);
  }
}

function releaseCaptureLeaseIfOwned(draftsDir, expectedLease) {
  if (!expectedLease) return false;
  const filePath = path.join(draftsDir, CAPTURE_LOCK_FILE);
  const snapshot = readOwnerSnapshot(filePath, "voice draft capture lease");
  if (snapshot.missing || !snapshot.record || !sameLeaseOwner(snapshot.record, expectedLease)) return false;
  unlinkIfIdentityMatches(filePath, snapshot.stat, "voice draft capture lease");
  return true;
}

function readCaptureLeaseRecord(draftsDir, lockOptions = {}) {
  const filePath = path.join(draftsDir, CAPTURE_LOCK_FILE);
  if (!pathEntryExists(filePath)) {
    return null;
  }
  const snapshot = readOwnerSnapshot(filePath, "voice draft capture lease", lockOptions);
  if (snapshot.record) return snapshot.record;
  if (!snapshot.stale) {
    throw statusError(409, "voice draft capture lease is incomplete; retry after the stale interval");
  }
  takeoverStaleOwnerFile(filePath, snapshot, "voice draft capture lease");
  return null;
}

function sameLeaseOwner(left, right) {
  if (!left || !right) return false;
  if (left.owner_id && right.owner_id) return left.owner_id === right.owner_id;
  return left.draft_id === right.draft_id
    && left.lease_id === right.lease_id
    && left.pid === right.pid
    && left.process_boot_id === right.process_boot_id;
}

function isLiveLeaseRecord(record) {
  if (!record || !isLockOwnerLive(record)) return false;
  try {
    requireExactToken(record.draft_id, "draft_id", DEFAULT_MAX_CORRELATION_LENGTH);
    requireExactToken(record.lease_id, "capture_lease_id", DEFAULT_MAX_CORRELATION_LENGTH);
    return true;
  } catch {
    return false;
  }
}

function isLockOwnerLive(record) {
  if (
    !record
    || typeof record.pid !== "number"
    || !Number.isSafeInteger(record.pid)
    || record.pid <= 0
    || !isExactToken(record.process_boot_id, 80)
  ) {
    return false;
  }
  if (record.pid === process.pid) {
    return record.process_boot_id === PROCESS_BOOT_ID;
  }
  try {
    process.kill(record.pid, 0);
    return true;
  } catch (error) {
    if (error && error.code === "EPERM") {
      return true;
    }
    return false;
  }
}

function findRecordedAction(draft, request) {
  const keyHash = hashIdempotencyKey(request.idempotency_key);
  const history = Array.isArray(draft.transition_history) ? draft.transition_history : [];
  const recent = history.find((entry) => entry.idempotency_key_hash === keyHash);
  if (recent) {
    if (recent.action !== request.action) {
      throw statusError(409, `idempotency key ${request.idempotency_key} already recorded for ${recent.action}`);
    }
    if (!recent.request || !sameJson(recent.request, request)) {
      throw statusError(409, `idempotency key ${request.idempotency_key} was retried with a different request`);
    }
    return recent.receipt;
  }
  if ((draft.used_action_key_hashes || []).includes(keyHash)) {
    throw statusError(409, `idempotency key ${request.idempotency_key} was already used and is no longer replayable`);
  }
  return null;
}

function rememberTransition(draft, request, receipt, limits, options = {}) {
  const keyHash = hashIdempotencyKey(request.idempotency_key);
  if (!options.systemRecovery && !(draft.used_action_key_hashes || []).includes(keyHash)) {
    const terminalCleanup = request.action === "discard" || request.action === "mark_sent";
    if (!terminalCleanup && (draft.used_action_key_hashes || []).length >= limits.maxActionKeyHashes) {
      throw statusError(507, "voice draft durable idempotency capacity exceeded");
    }
    draft.used_action_key_hashes = [...(draft.used_action_key_hashes || []), keyHash];
  }
  const history = Array.isArray(draft.transition_history) ? draft.transition_history : [];
  history.push({
    action: request.action,
    idempotency_key_hash: keyHash,
    request: clone(request),
    receipt: clone(receipt),
  });
  draft.transition_history = history.slice(-limits.maxTransitionHistory);
}

function normalizeCreateRequest(input, limits) {
  const partialTranscript = boundedPartialTranscript(
    aliasedInput(input, ["partial_transcript", "partialTranscript"], "partial_transcript"),
    limits,
  );
  return {
    type: "voice_draft_create_request",
    revision: STATE_MACHINE_REVISION,
    idempotency_key: requireIdempotencyKey(
      aliasedInput(input, ["idempotency_key", "idempotencyKey"], "idempotency_key"),
    ),
    session_id: requireAuthorityToken(
      aliasedInput(input, ["session_id", "sessionId"], "session_id"),
      "session_id",
    ),
    branch_id: requireAuthorityToken(
      aliasedInput(input, ["branch_id", "branchId"], "branch_id"),
      "branch_id",
    ),
    source: optionalAliasedAuthority(input, ["source"], "source"),
    surface: optionalAliasedAuthority(input, ["surface"], "surface"),
    source_session_id: optionalAliasedAuthority(
      input,
      ["source_session_id", "sourceSessionId"],
      "source_session_id",
    ),
    parent_intent_id: optionalAliasedAuthority(
      input,
      ["parent_intent_id", "parentIntentId"],
      "parent_intent_id",
    ),
    release_id: optionalAliasedAuthority(input, ["release_id", "releaseId"], "release_id"),
    release_version: optionalAliasedAuthority(
      input,
      ["release_version", "releaseVersion"],
      "release_version",
    ),
    context_action: optionalAliasedAuthority(
      input,
      ["context_action", "contextAction"],
      "context_action",
    ),
    capture_lease_id: optionalAliasedAuthority(
      input,
      ["capture_lease_id", "captureLeaseId"],
      "capture_lease_id",
    ),
    partial_transcript_sha256: partialTranscript
      ? digestBytes(Buffer.from(partialTranscript, "utf8"))
      : "",
  };
}

function findCreateResult(draftsDir, request, limits) {
  const expired = findExpiredReplayByCreate(draftsDir, request.idempotency_key, limits);
  if (expired) {
    if (!sameJson(expired.create_request, request)) {
      throw statusError(
        409,
        `create idempotency key ${request.idempotency_key} was retried with a different request`,
      );
    }
    throw expiredReplayError(expired);
  }
  const matches = [];
  for (const draftId of listAuthoritativeDraftIds(draftsDir)) {
    const record = loadRequiredRecord(draftsDir, draftId, limits);
    if (record.create_request.idempotency_key !== request.idempotency_key) {
      continue;
    }
    matches.push(record);
  }
  if (matches.length > 1) {
    throw statusError(
      500,
      `voice draft create idempotency authority ${request.idempotency_key} is duplicated by ${matches.map((record) => record.draft_id || record.id).join(", ")}`,
    );
  }
  const matched = matches[0] || null;
  if (matched && !sameJson(matched.create_request, request)) {
    throw statusError(
      409,
      `create idempotency key ${request.idempotency_key} was retried with a different request`,
    );
  }
  if (matched?.kind === EXPIRED_REPLAY_KIND) {
    throw expiredReplayError(matched);
  }
  return matched;
}

function normalizeStoredCreateRequest(value, draft) {
  if (value === undefined || value === null) {
    throw statusError(500, "voice draft v2 metadata requires canonical create request authority");
  }
  if (!isPlainObject(value)) {
    throw statusError(500, "voice draft persisted create request is invalid");
  }
  assertExactStoredFields(value, [
    "type",
    "revision",
    "idempotency_key",
    "session_id",
    "branch_id",
    "source",
    "surface",
    "source_session_id",
    "parent_intent_id",
    "release_id",
    "release_version",
    "context_action",
    "capture_lease_id",
    "partial_transcript_sha256",
  ], "create_request");
  if (value.type !== "voice_draft_create_request" || value.revision !== STATE_MACHINE_REVISION) {
    throw statusError(500, "voice draft persisted create request revision is incompatible");
  }
  const normalized = {
    type: value.type,
    revision: value.revision,
    idempotency_key: requireStoredAuthorityToken(value.idempotency_key, "create_request.idempotency_key"),
    session_id: requireStoredAuthorityToken(value.session_id, "create_request.session_id"),
    branch_id: requireStoredAuthorityToken(value.branch_id, "create_request.branch_id"),
    source: requireStoredOptionalAuthorityToken(value.source, "create_request.source"),
    surface: requireStoredOptionalAuthorityToken(value.surface, "create_request.surface"),
    source_session_id: requireStoredOptionalAuthorityToken(
      value.source_session_id,
      "create_request.source_session_id",
    ),
    parent_intent_id: requireStoredOptionalAuthorityToken(
      value.parent_intent_id,
      "create_request.parent_intent_id",
    ),
    release_id: requireStoredOptionalAuthorityToken(value.release_id, "create_request.release_id"),
    release_version: requireStoredOptionalAuthorityToken(
      value.release_version,
      "create_request.release_version",
    ),
    context_action: requireStoredOptionalAuthorityToken(value.context_action, "create_request.context_action"),
    capture_lease_id: requireStoredOptionalAuthorityToken(
      value.capture_lease_id,
      "create_request.capture_lease_id",
    ),
    partial_transcript_sha256: requireStoredDigest(
      value.partial_transcript_sha256,
      "create_request.partial_transcript_sha256",
      true,
    ),
  };
  if (draft && normalized.session_id !== draft.session_id) {
    throw statusError(500, "voice draft persisted create request session authority disagrees");
  }
  return normalized;
}

function normalizeStoredMutationAnchor(value) {
  if (!isPlainObject(value)) {
    throw statusError(500, "voice draft persisted mutation anchor is invalid");
  }
  assertExactStoredFields(value, [
    "type",
    "revision",
    "mutation",
    "previous_revision",
    "draft_revision",
    "state",
    "at",
    "request_sha256",
  ], "mutation_anchor");
  if (
    value.type !== "voice_draft_mutation_anchor"
    || value.revision !== STATE_MACHINE_REVISION
    || !new Set(["create", "append", "transition", "claim"]).has(value.mutation)
    || !Object.prototype.hasOwnProperty.call(LEGAL_TRANSITIONS, value.state)
  ) {
    throw statusError(500, "voice draft persisted mutation anchor authority is invalid");
  }
  return {
    type: value.type,
    revision: value.revision,
    mutation: value.mutation,
    previous_revision: requireStoredNonNegativeInteger(
      value.previous_revision,
      "mutation_anchor.previous_revision",
    ),
    draft_revision: requireStoredPositiveInteger(
      value.draft_revision,
      "mutation_anchor.draft_revision",
    ),
    state: value.state,
    at: requireStoredTimestamp(value.at, "mutation_anchor.at"),
    request_sha256: requireStoredDigest(
      value.request_sha256,
      "mutation_anchor.request_sha256",
      false,
    ),
  };
}

function maxAuthorityChainEntries(limits) {
  return 4
    + limits.maxSegmentsPerDraft
    + ((limits.maxActionKeyHashes + 1) * 2);
}

function normalizeStoredAuthorityChain(value, draftId, limits) {
  if (!Array.isArray(value) || value.length === 0) {
    throw statusError(500, "voice draft persisted authority chain must be a non-empty array");
  }
  if (value.length > maxAuthorityChainEntries(limits)) {
    throw statusError(500, "voice draft persisted authority chain exceeds configured limits");
  }
  const normalized = [];
  for (let index = 0; index < value.length; index += 1) {
    const raw = value[index];
    if (!isPlainObject(raw)) {
      throw statusError(500, "voice draft persisted authority-chain entry is invalid");
    }
    assertExactStoredFields(raw, AUTHORITY_CHAIN_FIELDS, "authority_chain.entry");
    if (
      raw.type !== "voice_draft_authority_chain_entry"
      || raw.revision !== STATE_MACHINE_REVISION
      || raw.draft_id !== draftId
      || !new Set(["create", "append", "transition", "claim"]).has(raw.mutation)
      || !AUTHORITY_CHAIN_OPERATIONS.has(raw.operation)
      || typeof raw.system_recovery !== "boolean"
    ) {
      throw statusError(500, "voice draft persisted authority-chain identity is invalid");
    }
    const stateBefore = raw.state_before === ""
      ? ""
      : requireStoredExactToken(raw.state_before, "authority_chain.state_before", 40);
    const stateAfter = requireStoredExactToken(
      raw.state_after,
      "authority_chain.state_after",
      40,
    );
    if (
      (stateBefore && !Object.prototype.hasOwnProperty.call(LEGAL_TRANSITIONS, stateBefore))
      || !Object.prototype.hasOwnProperty.call(LEGAL_TRANSITIONS, stateAfter)
    ) {
      throw statusError(500, "voice draft persisted authority-chain state is invalid");
    }
    const entry = {
      type: raw.type,
      revision: raw.revision,
      draft_id: raw.draft_id,
      mutation: raw.mutation,
      operation: raw.operation,
      previous_revision: requireStoredNonNegativeInteger(
        raw.previous_revision,
        "authority_chain.previous_revision",
      ),
      draft_revision: requireStoredPositiveInteger(
        raw.draft_revision,
        "authority_chain.draft_revision",
      ),
      state_before: stateBefore,
      state_after: stateAfter,
      at: requireStoredTimestamp(raw.at, "authority_chain.at"),
      request_sha256: requireStoredDigest(
        raw.request_sha256,
        "authority_chain.request_sha256",
        false,
      ),
      action_key_hash: requireStoredDigest(
        raw.action_key_hash,
        "authority_chain.action_key_hash",
        true,
      ),
      system_recovery: raw.system_recovery,
      pre_content: normalizeStoredPreContent(raw.pre_content),
      evidence_sha256: requireStoredDigest(
        raw.evidence_sha256,
        "authority_chain.evidence_sha256",
        false,
      ),
      previous_chain_sha256: requireStoredDigest(
        raw.previous_chain_sha256,
        "authority_chain.previous_chain_sha256",
        true,
      ),
      chain_sha256: requireStoredDigest(
        raw.chain_sha256,
        "authority_chain.chain_sha256",
        false,
      ),
    };
    const prior = normalized.at(-1) || null;
    if (
      entry.previous_revision !== index
      || entry.draft_revision !== index + 1
      || entry.previous_chain_sha256 !== (prior?.chain_sha256 || "")
      || (prior && entry.state_before !== prior.state_after)
      || entry.chain_sha256 !== digestCanonicalValue(authorityChainEntryDigestPayload(entry))
    ) {
      throw statusError(500, "voice draft persisted authority chain is not contiguous");
    }
    validateAuthorityChainOperation(entry, index);
    normalized.push(entry);
  }
  return normalized;
}

function normalizeStoredPreContent(value) {
  if (value === null) return null;
  if (!isPlainObject(value)) {
    throw statusError(500, "voice draft persisted pre-cleanup content authority is invalid");
  }
  assertExactStoredFields(value, PRE_CONTENT_FIELDS, "authority_chain.pre_content");
  return {
    bytes: requireStoredNonNegativeInteger(value.bytes, "authority_chain.pre_content.bytes"),
    duration_ms: requireStoredNonNegativeInteger(
      value.duration_ms,
      "authority_chain.pre_content.duration_ms",
    ),
    segment_count: requireStoredNonNegativeInteger(
      value.segment_count,
      "authority_chain.pre_content.segment_count",
    ),
    audio_sha256: requireStoredDigest(
      value.audio_sha256,
      "authority_chain.pre_content.audio_sha256",
      true,
    ),
    segments_sha256: requireStoredDigest(
      value.segments_sha256,
      "authority_chain.pre_content.segments_sha256",
      false,
    ),
    partial_transcript_sha256: requireStoredDigest(
      value.partial_transcript_sha256,
      "authority_chain.pre_content.partial_transcript_sha256",
      false,
    ),
    partial_transcript_updated_at: requireStoredTimestamp(
      value.partial_transcript_updated_at,
      "authority_chain.pre_content.partial_transcript_updated_at",
    ),
  };
}

function validateAuthorityChainOperation(entry, index) {
  const transitionOperation = new Set([
    "pause",
    "resume",
    "park",
    "recovery_park",
    "send_ready",
    "discard",
    "mark_sent",
  ]).has(entry.operation);
  if (entry.operation === "create") {
    if (
      index !== 0
      || entry.mutation !== "create"
      || entry.state_before !== ""
      || entry.state_after !== "capturing"
      || entry.action_key_hash
      || entry.system_recovery
      || entry.pre_content
    ) {
      throw statusError(500, "voice draft persisted create authority-chain entry is contradictory");
    }
    return;
  }
  if (index === 0 || !entry.state_before) {
    throw statusError(500, "voice draft persisted authority chain is missing a create root");
  }
  if (entry.operation === "append") {
    if (
      entry.mutation !== "append"
      || entry.state_before !== "capturing"
      || entry.state_after !== "capturing"
      || entry.action_key_hash
      || entry.system_recovery
      || entry.pre_content
    ) {
      throw statusError(500, "voice draft persisted append authority-chain entry is contradictory");
    }
    return;
  }
  if (entry.operation === "claim_for_turn") {
    if (
      entry.mutation !== "claim"
      || entry.state_before !== "send_ready"
      || entry.state_after !== "send_ready"
      || entry.action_key_hash
      || entry.system_recovery
      || entry.pre_content
    ) {
      throw statusError(500, "voice draft persisted claim authority-chain entry is contradictory");
    }
    return;
  }
  if (!transitionOperation || entry.mutation !== "transition" || !entry.action_key_hash) {
    throw statusError(500, "voice draft persisted transition authority-chain entry is invalid");
  }
  if (entry.operation === "recovery_park") {
    if (
      !entry.system_recovery
      || !ACTIVE_CAPTURE_STATES.has(entry.state_before)
      || entry.state_after !== "parked"
      || entry.pre_content
    ) {
      throw statusError(500, "voice draft persisted recovery authority-chain entry is contradictory");
    }
    return;
  }
  if (entry.system_recovery) {
    throw statusError(500, "voice draft persisted user mutation is marked as system recovery");
  }
  if (entry.operation === "mark_sent") {
    if (
      entry.state_before !== "send_ready"
      || entry.state_after !== "sent"
      || !entry.pre_content
    ) {
      throw statusError(500, "voice draft persisted sent authority-chain entry is contradictory");
    }
    return;
  }
  if (
    !LEGAL_TRANSITIONS[entry.state_before]?.has(entry.operation)
    || entry.state_after !== nextStateForAction(entry.operation)
    || ((entry.operation === "discard") !== Boolean(entry.pre_content))
  ) {
    throw statusError(500, "voice draft persisted authority chain contains an illegal state change");
  }
}

function normalizeStoredCaptureLease(value, draftId) {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) {
    throw statusError(500, "voice draft persisted capture lease is invalid");
  }
  assertExactStoredFields(value, [
    "type",
    "owner_id",
    "draft_id",
    "lease_id",
    "pid",
    "process_boot_id",
    "acquired_at",
  ], "capture_lease");
  if (value.type !== "voice_draft_capture_lease") {
    throw statusError(500, "voice draft persisted capture lease type is invalid");
  }
  const lease = {
    type: value.type,
    owner_id: requireStoredAuthorityToken(value.owner_id, "capture_lease.owner_id"),
    draft_id: requireStoredAuthorityToken(value.draft_id, "capture_lease.draft_id"),
    lease_id: requireStoredAuthorityToken(value.lease_id, "capture_lease.lease_id"),
    pid: requireStoredPositiveInteger(value.pid, "capture_lease.pid"),
    process_boot_id: requireStoredAuthorityToken(value.process_boot_id, "capture_lease.process_boot_id"),
    acquired_at: requireStoredTimestamp(value.acquired_at, "capture_lease.acquired_at"),
  };
  if (lease.draft_id !== draftId) {
    throw statusError(500, "voice draft persisted capture lease references another draft");
  }
  return lease;
}

function normalizeStoredTransitionHistory(value, draftId, limits) {
  if (!Array.isArray(value)) {
    throw statusError(500, "voice draft persisted transition history must be an array");
  }
  if (value.length > limits.maxTransitionHistory) {
    throw statusError(500, "voice draft persisted transition history exceeds configured limits");
  }
  const seenHashes = new Set();
  let previousReceipt = null;
  let previousExpectedRevision = 0;
  return value.map((entry) => {
    if (!isPlainObject(entry) || !isPlainObject(entry.request) || !isPlainObject(entry.receipt)) {
      throw statusError(500, "voice draft persisted transition history entry is invalid");
    }
    assertExactStoredFields(
      entry,
      ["action", "idempotency_key_hash", "request", "receipt"],
      "transition_history.entry",
    );
    const action = requireStoredAuthorityToken(entry.action, "transition_history.action");
    const keyHash = requireStoredDigest(
      entry.idempotency_key_hash,
      "transition_history.idempotency_key_hash",
      false,
    );
    if (seenHashes.has(keyHash)) {
      throw statusError(500, "voice draft persisted transition history contains duplicate idempotency hashes");
    }
    seenHashes.add(keyHash);
    const request = normalizeStoredHistoryRequest(entry.request, draftId, action);
    const receipt = normalizeStoredTransitionReceipt(entry.receipt, draftId, action, request.idempotency_key);
    if (request.expected_revision <= previousExpectedRevision) {
      throw statusError(500, "voice draft persisted transition history revisions are not strictly increasing");
    }
    previousExpectedRevision = request.expected_revision;
    if (!sameJson(request.actor, receipt.actor)) {
      throw statusError(500, "voice draft persisted transition actor authority disagrees");
    }
    if (hashIdempotencyKey(request.idempotency_key) !== keyHash) {
      throw statusError(500, "voice draft persisted transition idempotency hash disagrees");
    }
    if (previousReceipt && previousReceipt.state_after !== receipt.state_before) {
      throw statusError(500, "voice draft persisted transition history state chain is contradictory");
    }
    previousReceipt = receipt;
    return {
      action,
      idempotency_key_hash: keyHash,
      request,
      receipt,
    };
  });
}

function normalizeStoredHistoryRequest(value, draftId, action) {
  if (!isPlainObject(value)) {
    throw statusError(500, "voice draft persisted transition request is invalid");
  }
  if (action === "mark_sent") {
    assertExactStoredFields(value, [
      "type",
      "revision",
      "draft_id",
      "action",
      "idempotency_key",
      "receipt_id",
      "expected_revision",
      "timestamp_semantics",
      "sent_at",
      "actor",
      "session_id",
      "branch_id",
      "turn_id",
      "source",
      "surface",
      "release_id",
      "release_version",
    ], "transition_history.request");
    if (
      value.type !== "voice_draft_mark_sent_request"
      || value.revision !== STATE_MACHINE_REVISION
      || value.draft_id !== draftId
      || value.action !== action
    ) {
      throw statusError(500, "voice draft persisted transition request authority disagrees");
    }
    const receiptId = requireStoredExactToken(
      value.receipt_id,
      "transition_history.request.receipt_id",
      DEFAULT_MAX_RECEIPT_LENGTH,
    );
    if (value.idempotency_key !== receiptId) {
      throw statusError(500, "voice draft persisted transition request receipt authority disagrees");
    }
    if (!new Set(["explicit", "server_assigned"]).has(value.timestamp_semantics)) {
      throw statusError(500, "voice draft persisted transition timestamp semantics are invalid");
    }
    const sentAt = value.sent_at === null
      ? null
      : requireStoredTimestamp(value.sent_at, "transition_history.request.sent_at");
    if ((value.timestamp_semantics === "explicit") !== (sentAt !== null)) {
      throw statusError(500, "voice draft persisted transition timestamp semantics disagree");
    }
    return {
      type: value.type,
      revision: value.revision,
      draft_id: value.draft_id,
      action: value.action,
      idempotency_key: receiptId,
      receipt_id: receiptId,
      expected_revision: requireStoredPositiveInteger(
        value.expected_revision,
        "transition_history.request.expected_revision",
      ),
      timestamp_semantics: value.timestamp_semantics,
      sent_at: sentAt,
      actor: normalizeStoredActor(value.actor, "transition_history.request.actor"),
      session_id: requireStoredAuthorityToken(value.session_id, "transition_history.request.session_id"),
      branch_id: requireStoredAuthorityToken(value.branch_id, "transition_history.request.branch_id"),
      turn_id: requireStoredAuthorityToken(value.turn_id, "transition_history.request.turn_id"),
      source: requireStoredOptionalAuthorityToken(value.source, "transition_history.request.source"),
      surface: requireStoredOptionalAuthorityToken(value.surface, "transition_history.request.surface"),
      release_id: requireStoredOptionalAuthorityToken(value.release_id, "transition_history.request.release_id"),
      release_version: requireStoredOptionalAuthorityToken(
        value.release_version,
        "transition_history.request.release_version",
      ),
    };
  }
  assertExactStoredFields(value, [
    "type",
    "revision",
    "draft_id",
    "action",
    "idempotency_key",
    "actor",
    "expected_revision",
  ], "transition_history.request");
  if (
    value.type !== "voice_draft_transition_request"
    || value.revision !== STATE_MACHINE_REVISION
    || value.draft_id !== draftId
    || value.action !== action
  ) {
    throw statusError(500, "voice draft persisted transition request authority disagrees");
  }
  return {
    type: value.type,
    revision: value.revision,
    draft_id: value.draft_id,
    action: value.action,
    idempotency_key: requireStoredAuthorityToken(
      value.idempotency_key,
      "transition_history.request.idempotency_key",
    ),
    actor: normalizeStoredActor(value.actor, "transition_history.request.actor"),
    expected_revision: requireStoredPositiveInteger(
      value.expected_revision,
      "transition_history.request.expected_revision",
    ),
  };
}

function normalizeStoredTransitionReceipt(value, draftId, action, requestKey) {
  if (!isPlainObject(value)) {
    throw statusError(500, "voice draft persisted transition receipt is invalid");
  }
  assertExactStoredFields(value, [
    "type",
    "revision",
    "draft_id",
    "action",
    "idempotency_key",
    "actor",
    "state_before",
    "state_after",
    "at",
  ], "transition_history.receipt");
  if (
    value.type !== "voice_draft_transition_receipt"
    || value.revision !== STATE_MACHINE_REVISION
    || value.draft_id !== draftId
    || value.action !== action
    || value.idempotency_key !== requestKey
    || !Object.prototype.hasOwnProperty.call(LEGAL_TRANSITIONS, value.state_before)
    || !Object.prototype.hasOwnProperty.call(LEGAL_TRANSITIONS, value.state_after)
  ) {
    throw statusError(500, "voice draft persisted transition receipt authority disagrees");
  }
  const legalStateAfter = action === "mark_sent"
    ? value.state_before === "send_ready" && value.state_after === "sent"
    : Boolean(LEGAL_TRANSITIONS[value.state_before]?.has(action))
      && value.state_after === nextStateForAction(action);
  if (!legalStateAfter) {
    throw statusError(500, "voice draft persisted transition history contains an illegal state change");
  }
  return {
    type: value.type,
    revision: value.revision,
    draft_id: value.draft_id,
    action: value.action,
    idempotency_key: value.idempotency_key,
    actor: normalizeStoredActor(value.actor, "transition_history.receipt.actor"),
    state_before: value.state_before,
    state_after: value.state_after,
    at: requireStoredTimestamp(value.at, "transition_history.receipt.at"),
  };
}

function normalizeStoredActionKeyHashes(value, state, limits) {
  if (!Array.isArray(value)) {
    throw statusError(500, "voice draft persisted action-key hashes must be an array");
  }
  const terminalReplayAllowance = TERMINAL_STATES.has(state) ? 1 : 0;
  if (value.length > limits.maxActionKeyHashes + terminalReplayAllowance) {
    throw statusError(500, "voice draft persisted action-key hashes exceed configured limits");
  }
  const hashes = value.map((hash) => requireStoredDigest(hash, "used_action_key_hash", false));
  if (new Set(hashes).size !== hashes.length) {
    throw statusError(500, "voice draft persisted action-key hashes contain duplicates");
  }
  return hashes;
}

function normalizeLimits(options) {
  const maxDrafts = positiveInt(options.maxDrafts, DEFAULT_MAX_DRAFTS);
  const maxMetadataBytes = positiveInt(options.maxMetadataBytes, DEFAULT_MAX_METADATA_BYTES);
  const maxActionKeyHashes = positiveInt(options.maxActionKeyHashes, DEFAULT_MAX_ACTION_KEY_HASHES);
  return {
    maxDrafts,
    maxTerminalDrafts: positiveInt(
      options.maxTerminalDrafts,
      Math.max(DEFAULT_MAX_TERMINAL_DRAFTS, maxDrafts),
    ),
    maxExpiredReplayRecords: positiveInt(
      options.maxExpiredReplayRecords,
      DEFAULT_MAX_EXPIRED_REPLAY_RECORDS,
    ),
    maxReplayIndexBytes: positiveInt(
      options.maxReplayIndexBytes,
      DEFAULT_MAX_REPLAY_INDEX_BYTES,
    ),
    maxTotalBytes: positiveInt(options.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES),
    maxMetadataBytes,
    maxSegmentBytes: nonNegativeIntOption(options.maxSegmentBytes, DEFAULT_MAX_SEGMENT_BYTES, "maxSegmentBytes"),
    maxSegmentsPerDraft: positiveInt(options.maxSegmentsPerDraft, DEFAULT_MAX_SEGMENTS_PER_DRAFT),
    maxSegmentDurationMs: positiveInt(options.maxSegmentDurationMs, DEFAULT_MAX_SEGMENT_DURATION_MS),
    maxDraftBytes: positiveInt(options.maxDraftBytes, DEFAULT_MAX_DRAFT_BYTES),
    maxDraftDurationMs: positiveInt(options.maxDraftDurationMs, DEFAULT_MAX_DRAFT_DURATION_MS),
    maxListLimit: positiveInt(options.maxListLimit, DEFAULT_MAX_LIST_LIMIT),
    maxPartialTranscriptChars: positiveInt(options.maxPartialTranscriptChars, DEFAULT_MAX_PARTIAL_TRANSCRIPT_CHARS),
    maxTransitionHistory: positiveInt(options.maxTransitionHistory, DEFAULT_MAX_TRANSITION_HISTORY),
    maxActionKeyHashes,
    expiredReplayRecordReservationBytes: Math.min(
      maxMetadataBytes,
      REPLAY_INDEX_BASE_RESERVATION_BYTES
        + ((maxActionKeyHashes + 1) * REPLAY_INDEX_HASH_RESERVATION_BYTES),
    ),
  };
}

function normalizeAction(value) {
  return requireExactToken(value, "action", DEFAULT_MAX_CORRELATION_LENGTH);
}

function canonicalTransitionRequest(draftId, action, idempotencyKey, actor, expectedRevision) {
  return {
    type: "voice_draft_transition_request",
    revision: STATE_MACHINE_REVISION,
    draft_id: draftId,
    action,
    idempotency_key: idempotencyKey,
    actor: clone(actor),
    expected_revision: expectedRevision,
  };
}

function nextStateForAction(action) {
  if (action === "pause") return "paused";
  if (action === "resume") return "capturing";
  if (action === "park") return "parked";
  if (action === "send_ready") return "send_ready";
  if (action === "discard") return "discarded";
  throw statusError(400, `unsupported voice draft action ${action}`);
}

function assertLegalTransition(state, action) {
  const allowed = LEGAL_TRANSITIONS[state];
  if (!allowed || !allowed.has(action)) {
    throw statusError(409, `illegal voice draft transition ${state} -> ${action}`);
  }
}

function normalizeActor(value) {
  if (value === undefined || value === null) {
    return { kind: "user", id: "voice-drafts" };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw statusError(400, "actor must be an object");
  }
  return {
    kind: value.kind === undefined
      ? "user"
      : requireExactToken(value.kind, "actor.kind", DEFAULT_MAX_ACTOR_LENGTH),
    id: value.id === undefined
      ? "voice-drafts"
      : requireExactToken(value.id, "actor.id", DEFAULT_MAX_ACTOR_LENGTH),
  };
}

function requireIdempotencyKey(value) {
  return requireExactToken(value, "idempotency_key", DEFAULT_MAX_CORRELATION_LENGTH);
}

function assertExpectedRevisionValue(draft, expectedRevision) {
  const currentRevision = requireStoredPositiveInteger(draft.revision, "revision");
  if (currentRevision !== expectedRevision) {
    throw statusError(409, `voice draft revision conflict: expected ${expectedRevision}, current ${currentRevision}`);
  }
}

function assertMutationRevisionCapacity(draft) {
  if (draft.revision >= Number.MAX_SAFE_INTEGER) {
    throw statusError(507, "voice draft revision capacity exceeded");
  }
}

function normalizeTurnClaim(input, draft) {
  const sessionId = requireAuthorityToken(aliasedInput(input, ["session_id", "sessionId"], "session_id"), "session_id");
  const branchId = requireAuthorityToken(aliasedInput(input, ["branch_id", "branchId"], "branch_id"), "branch_id");
  const turnId = requireAuthorityToken(aliasedInput(input, ["turn_id", "turnId"], "turn_id"), "turn_id");
  if (!draft.session_id || !draft.branch_id) {
    throw statusError(409, "voice draft creation authority is missing; claim is not allowed");
  }
  if (draft.session_id !== sessionId) {
    throw statusError(409, "voice draft session_id does not match the claim");
  }
  if (draft.branch_id !== branchId) {
    throw statusError(409, "voice draft branch_id does not match the claim");
  }
  return { session_id: sessionId, branch_id: branchId, turn_id: turnId };
}

function normalizeSentCommand(input, draft) {
  const receiptIdInput = aliasedInput(
    input,
    ["receipt_id", "receiptId", "idempotency_key", "idempotencyKey"],
    "receipt_id",
  );
  const receiptId = requireExactToken(receiptIdInput, "receipt_id", DEFAULT_MAX_RECEIPT_LENGTH);
  const sessionId = requireAuthorityToken(aliasedInput(input, ["session_id", "sessionId"], "session_id"), "session_id");
  const branchId = requireAuthorityToken(aliasedInput(input, ["branch_id", "branchId"], "branch_id"), "branch_id");
  const turnId = requireAuthorityToken(aliasedInput(input, ["turn_id", "turnId"], "turn_id"), "turn_id");
  const actor = normalizeActor(input.actor);
  const source = authorityInputOrFallback(input, ["source"], "source", draft.source);
  const surface = authorityInputOrFallback(input, ["surface"], "surface", draft.surface);
  const releaseId = authorityInputOrFallback(input, ["release_id", "releaseId"], "release_id", draft.release_id);
  const releaseVersion = authorityInputOrFallback(
    input,
    ["release_version", "releaseVersion"],
    "release_version",
    draft.release_version,
  );
  assertCreationAuthorityMatch(draft, { source, surface, release_id: releaseId, release_version: releaseVersion });
  const expectedRevision = normalizeExpectedRevision(
    aliasedInput(input, ["expected_revision", "expectedRevision"], "expected_revision"),
  );
  const sentAtInput = firstOwnInput(input, ["sent_at", "sentAt"]);
  let explicitSentAt = "";
  if (sentAtInput.present) {
    const rawSentAt = aliasedInput(input, ["sent_at", "sentAt"], "sent_at");
    if (typeof rawSentAt !== "string") {
      throw statusError(400, "sent_at must be a canonical string timestamp when provided");
    }
    explicitSentAt = normalizeTimestamp(rawSentAt);
    if (!explicitSentAt || explicitSentAt !== rawSentAt) {
      throw statusError(400, "sent_at must be a canonical string timestamp when provided");
    }
  }
  const request = {
    type: "voice_draft_mark_sent_request",
    revision: STATE_MACHINE_REVISION,
    draft_id: draft.id,
    action: "mark_sent",
    idempotency_key: receiptId,
    receipt_id: receiptId,
    expected_revision: expectedRevision,
    timestamp_semantics: sentAtInput.present ? "explicit" : "server_assigned",
    sent_at: explicitSentAt || null,
    actor,
    session_id: sessionId,
    branch_id: branchId,
    turn_id: turnId,
    source,
    surface,
    release_id: releaseId,
    release_version: releaseVersion,
  };
  const receipt = {
    type: "voice_draft_sent_receipt",
    revision: STATE_MACHINE_REVISION,
    draft_id: draft.id,
    receipt_id: receiptId,
    sent_at: explicitSentAt || new Date().toISOString(),
    actor,
    session_id: sessionId,
    branch_id: branchId,
    turn_id: turnId,
    source,
    surface,
    release_id: releaseId,
    release_version: releaseVersion,
  };
  return { request, receipt };
}

function assertCreationAuthorityMatch(draft, authority) {
  for (const field of ["source", "surface", "release_id", "release_version"]) {
    const expected = draft[field] || "";
    if (authority[field] !== expected) {
      throw statusError(409, `sent ${field} does not match voice draft creation authority`);
    }
  }
}

function boundedPartialTranscript(value, limits) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") {
    throw statusError(400, "partial_transcript must be a string");
  }
  const text = value.trim().replace(/\s+/g, " ");
  if (text.length > limits.maxPartialTranscriptChars) {
    throw statusError(400, `partial_transcript exceeds ${limits.maxPartialTranscriptChars} characters`);
  }
  return text;
}

function normalizeCanonicalContentType(value) {
  const contentType = cleanText(value, 160) || CANONICAL_CONTENT_TYPE;
  if (contentType !== CANONICAL_CONTENT_TYPE) {
    throw statusError(415, "voice draft content_type must be canonical PCM16 mono 16kHz");
  }
  return contentType;
}

function normalizeCanonicalPcmBytes(value) {
  const bytes = normalizeBytes(value);
  if (bytes.length <= 0) {
    throw statusError(400, "voice draft segment bytes are empty");
  }
  if (bytes.length % 2 !== 0) {
    throw statusError(400, "voice draft PCM byte length must be even");
  }
  return bytes;
}

function normalizeBytes(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value, "base64");
  return Buffer.alloc(0);
}

function normalizeOptionalDigest(value) {
  const text = cleanText(value, 128).toLowerCase();
  if (!text) return "";
  if (!/^[a-f0-9]{64}$/.test(text)) {
    throw statusError(400, "sha256 must be a lowercase 64-hex digest");
  }
  return text;
}

function normalizeOptionalByteCount(value) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw statusError(400, "byte_count must be a number-typed non-negative safe integer");
  }
  return value;
}

function normalizeBoundedInteger(value, max, fieldName) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) {
    throw statusError(400, `${fieldName} must be a number-typed safe integer between 0 and ${max}`);
  }
  return value;
}

function normalizeExpectedRevision(value) {
  if (value === undefined || value === null || value === "") {
    throw statusError(400, "expected_revision is required");
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw statusError(400, "expected_revision must be a number-typed positive safe integer");
  }
  return value;
}

function requireAuthorityToken(value, field) {
  return requireExactToken(value, field, DEFAULT_MAX_CORRELATION_LENGTH);
}

function normalizeTimestamp(value) {
  const text = cleanText(value, DEFAULT_MAX_RECEIPT_LENGTH);
  if (!text) return "";
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function clampLimit(value, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return Math.min(50, max);
  return Math.min(Math.round(number), max);
}

function normalizeStateFilter(value) {
  if (!value) return null;
  const items = Array.isArray(value) ? value : String(value).split(",");
  const states = new Set(items.map((item) => cleanToken(item, 40)).filter(Boolean));
  return states.size ? states : null;
}

function positiveInt(value, fallback) {
  const number = Number(value);
  const rounded = Math.round(number);
  if (!Number.isSafeInteger(rounded) || rounded <= 0) return fallback;
  return rounded;
}

function nonNegativeIntOption(value, fallback, field) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw statusError(400, `${field} must be a non-negative integer`);
  }
  return number;
}

function cleanToken(value, maxLength) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.replace(/[^A-Za-z0-9._:-]/g, "").slice(0, maxLength);
}

function isExactToken(value, maxLength) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && AUTHORITY_TOKEN_PATTERN.test(value);
}

function cleanText(value, maxLength) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function firstOwnInput(input, names) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(input || {}, name)) {
      return { present: true, value: input[name] };
    }
  }
  return { present: false, value: undefined };
}

function aliasedInput(input, names, field) {
  const present = names
    .filter((name) => Object.prototype.hasOwnProperty.call(input || {}, name))
    .map((name) => ({ name, value: input[name] }));
  if (present.length === 0) return undefined;
  for (const candidate of present.slice(1)) {
    if (candidate.value !== present[0].value) {
      throw statusError(400, `${field} aliases disagree`);
    }
  }
  return present[0].value;
}

function requireExactToken(value, field, maxLength, statusCode = 400) {
  if (typeof value !== "string" || value.length === 0) {
    throw statusError(statusCode, `${field} is required`);
  }
  if (value.length > maxLength) {
    throw statusError(statusCode, `${field} exceeds ${maxLength} characters`);
  }
  if (!AUTHORITY_TOKEN_PATTERN.test(value)) {
    throw statusError(statusCode, `${field} contains invalid characters`);
  }
  return value;
}

function optionalAuthorityToken(value, field, maxLength = DEFAULT_MAX_CORRELATION_LENGTH) {
  if (value === undefined || value === null || value === "") return "";
  return requireExactToken(value, field, maxLength);
}

function optionalAliasedAuthority(input, names, field, maxLength = DEFAULT_MAX_CORRELATION_LENGTH) {
  return optionalAuthorityToken(aliasedInput(input, names, field), field, maxLength);
}

function authorityInputOrFallback(input, names, field, fallback) {
  const present = names.some((name) => Object.prototype.hasOwnProperty.call(input || {}, name));
  if (!present) return optionalAuthorityToken(fallback, field);
  return optionalAuthorityToken(aliasedInput(input, names, field), field);
}

function requireStoredAuthorityToken(value, field) {
  return requireStoredExactToken(value, field, DEFAULT_MAX_CORRELATION_LENGTH);
}

function requireStoredExactToken(value, field, maxLength) {
  try {
    return requireExactToken(value, field, maxLength);
  } catch (error) {
    throw statusError(500, `voice draft stored ${field} is invalid: ${error.message}`);
  }
}

function requireStoredOptionalAuthorityToken(value, field) {
  if (value === undefined || value === "") return "";
  try {
    return requireExactToken(value, field, DEFAULT_MAX_CORRELATION_LENGTH);
  } catch (error) {
    throw statusError(500, `voice draft stored ${field} is invalid: ${error.message}`);
  }
}

function requireStoredPositiveInteger(value, field) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw statusError(500, `voice draft stored ${field} must be a positive integer within safe range`);
  }
  return value;
}

function requireStoredNonNegativeInteger(value, field) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw statusError(500, `voice draft stored ${field} must be a non-negative integer within safe range`);
  }
  return value;
}

function requireStoredText(value, field) {
  if (typeof value !== "string") {
    throw statusError(500, `voice draft stored ${field} must be a string`);
  }
  return value;
}

function requireStoredBoundedText(value, field, maxLength) {
  const text = requireStoredText(value, field);
  if (text.length > maxLength) {
    throw statusError(500, `voice draft stored ${field} exceeds ${maxLength} characters`);
  }
  return text;
}

function requireStoredTimestamp(value, field) {
  if (typeof value !== "string" || !value || normalizeTimestamp(value) !== value) {
    throw statusError(500, `voice draft stored ${field} must be a canonical timestamp`);
  }
  return value;
}

function requireStoredOptionalTimestamp(value, field) {
  if (value === "") return "";
  return requireStoredTimestamp(value, field);
}

function requireStoredDigest(value, field, allowEmpty) {
  if (allowEmpty && value === "") return "";
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw statusError(500, `voice draft stored ${field} must be a lowercase 64-hex digest`);
  }
  return value;
}

function normalizeStoredActor(value, field) {
  if (!isPlainObject(value)) {
    throw statusError(500, `voice draft stored ${field} must be an actor object`);
  }
  assertExactStoredFields(value, ["kind", "id"], field);
  return {
    kind: requireStoredExactToken(value.kind, `${field}.kind`, DEFAULT_MAX_ACTOR_LENGTH),
    id: requireStoredExactToken(value.id, `${field}.id`, DEFAULT_MAX_ACTOR_LENGTH),
  };
}

function normalizeStoredClaim(value, draft) {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) {
    throw statusError(500, "voice draft stored claim must be an object");
  }
  assertExactStoredFields(value, ["session_id", "branch_id", "turn_id", "claimed_at"], "claim");
  const claim = {
    session_id: requireStoredAuthorityToken(value.session_id, "claim.session_id"),
    branch_id: requireStoredAuthorityToken(value.branch_id, "claim.branch_id"),
    turn_id: requireStoredAuthorityToken(value.turn_id, "claim.turn_id"),
    claimed_at: requireStoredTimestamp(value.claimed_at, "claim.claimed_at"),
  };
  if (claim.session_id !== draft.session_id || claim.branch_id !== draft.branch_id) {
    throw statusError(500, "voice draft stored claim disagrees with creation authority");
  }
  return claim;
}

function normalizeStoredClaimRequest(value, draft) {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) {
    throw statusError(500, "voice draft stored claim request must be an object");
  }
  assertExactStoredFields(value, [
    "type",
    "revision",
    "draft_id",
    "action",
    "expected_revision",
    "session_id",
    "branch_id",
    "turn_id",
  ], "claim_request");
  if (
    value.type !== "voice_draft_claim_request"
    || value.revision !== STATE_MACHINE_REVISION
    || value.draft_id !== draft.id
    || value.action !== "claim_for_turn"
  ) {
    throw statusError(500, "voice draft stored claim request authority is invalid");
  }
  const request = {
    type: value.type,
    revision: value.revision,
    draft_id: value.draft_id,
    action: value.action,
    expected_revision: requireStoredPositiveInteger(
      value.expected_revision,
      "claim_request.expected_revision",
    ),
    session_id: requireStoredAuthorityToken(value.session_id, "claim_request.session_id"),
    branch_id: requireStoredAuthorityToken(value.branch_id, "claim_request.branch_id"),
    turn_id: requireStoredAuthorityToken(value.turn_id, "claim_request.turn_id"),
  };
  if (request.session_id !== draft.session_id || request.branch_id !== draft.branch_id) {
    throw statusError(500, "voice draft stored claim request disagrees with creation authority");
  }
  return request;
}

function normalizeStoredSentReceipt(value, draft) {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) {
    throw statusError(500, "voice draft stored sent receipt must be an object");
  }
  assertExactStoredFields(value, [
    "type",
    "revision",
    "draft_id",
    "receipt_id",
    "sent_at",
    "actor",
    "session_id",
    "branch_id",
    "turn_id",
    "source",
    "surface",
    "release_id",
    "release_version",
  ], "sent_receipt");
  if (
    value.type !== "voice_draft_sent_receipt"
    || value.revision !== STATE_MACHINE_REVISION
    || value.draft_id !== draft.id
  ) {
    throw statusError(500, "voice draft stored sent receipt authority is invalid");
  }
  const receipt = {
    type: value.type,
    revision: value.revision,
    draft_id: value.draft_id,
    receipt_id: requireStoredExactToken(value.receipt_id, "sent_receipt.receipt_id", DEFAULT_MAX_RECEIPT_LENGTH),
    sent_at: requireStoredTimestamp(value.sent_at, "sent_receipt.sent_at"),
    actor: normalizeStoredActor(value.actor, "sent_receipt.actor"),
    session_id: requireStoredAuthorityToken(value.session_id, "sent_receipt.session_id"),
    branch_id: requireStoredAuthorityToken(value.branch_id, "sent_receipt.branch_id"),
    turn_id: requireStoredAuthorityToken(value.turn_id, "sent_receipt.turn_id"),
    source: requireStoredOptionalAuthorityToken(value.source, "sent_receipt.source"),
    surface: requireStoredOptionalAuthorityToken(value.surface, "sent_receipt.surface"),
    release_id: requireStoredOptionalAuthorityToken(value.release_id, "sent_receipt.release_id"),
    release_version: requireStoredOptionalAuthorityToken(
      value.release_version,
      "sent_receipt.release_version",
    ),
  };
  assertStoredSentCreationAuthority(draft, receipt);
  return receipt;
}

function normalizeStoredSentRequest(value, draft) {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) {
    throw statusError(500, "voice draft stored sent request must be an object");
  }
  assertExactStoredFields(value, [
    "type",
    "revision",
    "draft_id",
    "action",
    "idempotency_key",
    "receipt_id",
    "expected_revision",
    "timestamp_semantics",
    "sent_at",
    "actor",
    "session_id",
    "branch_id",
    "turn_id",
    "source",
    "surface",
    "release_id",
    "release_version",
  ], "sent_request");
  if (
    value.type !== "voice_draft_mark_sent_request"
    || value.revision !== STATE_MACHINE_REVISION
    || value.draft_id !== draft.id
    || value.action !== "mark_sent"
  ) {
    throw statusError(500, "voice draft stored sent request authority is invalid");
  }
  const receiptId = requireStoredExactToken(
    value.receipt_id,
    "sent_request.receipt_id",
    DEFAULT_MAX_RECEIPT_LENGTH,
  );
  if (value.idempotency_key !== receiptId) {
    throw statusError(500, "voice draft stored sent request idempotency authority disagrees");
  }
  if (!new Set(["explicit", "server_assigned"]).has(value.timestamp_semantics)) {
    throw statusError(500, "voice draft stored sent timestamp semantics are invalid");
  }
  const sentAt = value.sent_at === null ? null : requireStoredTimestamp(value.sent_at, "sent_request.sent_at");
  if ((value.timestamp_semantics === "explicit") !== (sentAt !== null)) {
    throw statusError(500, "voice draft stored sent timestamp semantics disagree");
  }
  const request = {
    type: value.type,
    revision: value.revision,
    draft_id: value.draft_id,
    action: value.action,
    idempotency_key: receiptId,
    receipt_id: receiptId,
    expected_revision: requireStoredPositiveInteger(value.expected_revision, "sent_request.expected_revision"),
    timestamp_semantics: value.timestamp_semantics,
    sent_at: sentAt,
    actor: normalizeStoredActor(value.actor, "sent_request.actor"),
    session_id: requireStoredAuthorityToken(value.session_id, "sent_request.session_id"),
    branch_id: requireStoredAuthorityToken(value.branch_id, "sent_request.branch_id"),
    turn_id: requireStoredAuthorityToken(value.turn_id, "sent_request.turn_id"),
    source: requireStoredOptionalAuthorityToken(value.source, "sent_request.source"),
    surface: requireStoredOptionalAuthorityToken(value.surface, "sent_request.surface"),
    release_id: requireStoredOptionalAuthorityToken(value.release_id, "sent_request.release_id"),
    release_version: requireStoredOptionalAuthorityToken(
      value.release_version,
      "sent_request.release_version",
    ),
  };
  assertStoredSentCreationAuthority(draft, request);
  return request;
}

function assertStoredSentCreationAuthority(draft, value) {
  if (value.session_id !== draft.session_id || value.branch_id !== draft.branch_id) {
    throw statusError(500, "voice draft stored sent authority disagrees with creation session");
  }
  for (const field of ["source", "surface", "release_id", "release_version"]) {
    if (value[field] !== (draft[field] || "")) {
      throw statusError(500, `voice draft stored sent ${field} disagrees with creation authority`);
    }
  }
}

function assertStoredSentRequestReceiptMatch(request, receipt) {
  for (const field of [
    "draft_id",
    "receipt_id",
    "session_id",
    "branch_id",
    "turn_id",
    "source",
    "surface",
    "release_id",
    "release_version",
  ]) {
    if (receipt[field] !== request[field]) {
      throw statusError(500, `voice draft persisted sent request disagrees with ${field}`);
    }
  }
  if (!sameJson(receipt.actor, request.actor)) {
    throw statusError(500, "voice draft persisted sent request disagrees with actor");
  }
  if (request.timestamp_semantics === "explicit" && receipt.sent_at !== request.sent_at) {
    throw statusError(500, "voice draft persisted sent request disagrees with timestamp");
  }
}

function normalizeStoredCleanupPending(value) {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) {
    throw statusError(500, "voice draft stored cleanup marker must be an object");
  }
  assertExactStoredFields(
    value,
    ["type", "revision", "mode", "at", "actor", "receipt_id", "files"],
    "cleanup_pending",
  );
  if (
    value.type !== "voice_draft_cleanup_pending"
    || value.revision !== STATE_MACHINE_REVISION
    || !new Set(["discarded", "sent"]).has(value.mode)
    || !Array.isArray(value.files)
  ) {
    throw statusError(500, "voice draft stored cleanup marker is invalid");
  }
  const files = value.files.map((file) => requireStoredText(file, "cleanup_pending.file"));
  const allowed = new Set([CANONICAL_AUDIO_FILE, JOURNAL_FILE]);
  if (
    files.length !== allowed.size
    || new Set(files).size !== files.length
    || files.some((file) => !allowed.has(file))
  ) {
    throw statusError(500, "voice draft stored cleanup files are invalid");
  }
  return {
    type: value.type,
    revision: value.revision,
    mode: value.mode,
    at: requireStoredTimestamp(value.at, "cleanup_pending.at"),
    actor: normalizeStoredActor(value.actor, "cleanup_pending.actor"),
    receipt_id: requireStoredExactToken(
      value.receipt_id,
      "cleanup_pending.receipt_id",
      DEFAULT_MAX_RECEIPT_LENGTH,
    ),
    files,
  };
}

function normalizeStoredTombstone(value, limits) {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) {
    throw statusError(500, "voice draft stored tombstone must be an object");
  }
  assertExactStoredFields(value, [
    "type",
    "revision",
    "mode",
    "at",
    "actor",
    "receipt_id",
    "audio_bytes_discarded",
    "duration_ms_discarded",
    "segment_count_discarded",
  ], "tombstone");
  if (
    value.type !== "voice_draft_tombstone"
    || value.revision !== STATE_MACHINE_REVISION
    || !new Set(["discarded", "sent"]).has(value.mode)
  ) {
    throw statusError(500, "voice draft stored tombstone is invalid");
  }
  const tombstone = {
    type: value.type,
    revision: value.revision,
    mode: value.mode,
    at: requireStoredTimestamp(value.at, "tombstone.at"),
    actor: normalizeStoredActor(value.actor, "tombstone.actor"),
    receipt_id: requireStoredExactToken(value.receipt_id, "tombstone.receipt_id", DEFAULT_MAX_RECEIPT_LENGTH),
    audio_bytes_discarded: requireStoredNonNegativeInteger(
      value.audio_bytes_discarded,
      "tombstone.audio_bytes_discarded",
    ),
    duration_ms_discarded: requireStoredNonNegativeInteger(
      value.duration_ms_discarded,
      "tombstone.duration_ms_discarded",
    ),
    segment_count_discarded: requireStoredNonNegativeInteger(
      value.segment_count_discarded,
      "tombstone.segment_count_discarded",
    ),
  };
  if (
    tombstone.audio_bytes_discarded > limits.maxDraftBytes
    || tombstone.duration_ms_discarded > limits.maxDraftDurationMs
    || tombstone.segment_count_discarded > limits.maxSegmentsPerDraft
  ) {
    throw statusError(500, "voice draft stored tombstone exceeds configured limits");
  }
  return tombstone;
}

function normalizeStoredSendReadyReceipt(value) {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value) || value.action !== "send_ready" || !isPlainObject(value.audio)) {
    throw statusError(500, "voice draft stored send-ready receipt is invalid");
  }
  assertExactStoredFields(
    value,
    ["action", "at", "actor", "idempotency_key", "audio"],
    "send_ready_receipt",
  );
  assertExactStoredFields(
    value.audio,
    ["content_type", "bytes", "duration_ms", "segment_count"],
    "send_ready_receipt.audio",
  );
  return {
    action: "send_ready",
    at: requireStoredTimestamp(value.at, "send_ready_receipt.at"),
    actor: normalizeStoredActor(value.actor, "send_ready_receipt.actor"),
    idempotency_key: requireStoredAuthorityToken(
      value.idempotency_key,
      "send_ready_receipt.idempotency_key",
    ),
    audio: {
      content_type: requireStoredText(value.audio.content_type, "send_ready_receipt.audio.content_type"),
      bytes: requireStoredPositiveInteger(value.audio.bytes, "send_ready_receipt.audio.bytes"),
      duration_ms: requireStoredNonNegativeInteger(
        value.audio.duration_ms,
        "send_ready_receipt.audio.duration_ms",
      ),
      segment_count: requireStoredPositiveInteger(
        value.audio.segment_count,
        "send_ready_receipt.audio.segment_count",
      ),
    },
  };
}

function normalizeStoredDiscardReceipt(value) {
  return normalizeStoredSimpleActionReceipt(value, "discard", "discard_receipt");
}

function normalizeStoredParkedReceipt(value) {
  return normalizeStoredSimpleActionReceipt(value, "park", "parked_receipt");
}

function normalizeStoredSimpleActionReceipt(value, action, field) {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value) || value.action !== action) {
    throw statusError(500, `voice draft stored ${field} is invalid`);
  }
  assertExactStoredFields(value, ["action", "at", "actor", "idempotency_key"], field);
  return {
    action,
    at: requireStoredTimestamp(value.at, `${field}.at`),
    actor: normalizeStoredActor(value.actor, `${field}.actor`),
    idempotency_key: requireStoredAuthorityToken(value.idempotency_key, `${field}.idempotency_key`),
  };
}

function normalizeStoredRecoveryReceipt(value) {
  if (value === undefined || value === null) return null;
  if (
    !isPlainObject(value)
    || value.type !== "voice_draft_recovery_receipt"
    || value.revision !== STATE_MACHINE_REVISION
    || !ACTIVE_CAPTURE_STATES.has(value.recovered_from)
    || value.reason !== "boot_recovery_auto_park"
  ) {
    throw statusError(500, "voice draft stored recovery receipt is invalid");
  }
  assertExactStoredFields(
    value,
    [
      "type",
      "revision",
      "recovered_from",
      "at",
      "reason",
      "idempotency_key",
      "expected_revision",
      "decision_sha256",
    ],
    "recovery_receipt",
  );
  const receipt = {
    type: value.type,
    revision: value.revision,
    recovered_from: value.recovered_from,
    at: requireStoredTimestamp(value.at, "recovery_receipt.at"),
    reason: value.reason,
    idempotency_key: requireStoredAuthorityToken(
      value.idempotency_key,
      "recovery_receipt.idempotency_key",
    ),
    expected_revision: requireStoredPositiveInteger(
      value.expected_revision,
      "recovery_receipt.expected_revision",
    ),
    decision_sha256: requireStoredDigest(
      value.decision_sha256,
      "recovery_receipt.decision_sha256",
      false,
    ),
  };
  if (receipt.decision_sha256 !== digestCanonicalValue(recoveryReceiptDecisionPayload(receipt))) {
    throw statusError(500, "voice draft stored recovery receipt decision digest disagrees");
  }
  return receipt;
}

function recoveryReceiptDecisionPayload(receipt) {
  return {
    type: receipt.type,
    revision: receipt.revision,
    recovered_from: receipt.recovered_from,
    at: receipt.at,
    reason: receipt.reason,
    idempotency_key: receipt.idempotency_key,
    expected_revision: receipt.expected_revision,
  };
}

function validateStoredDraftBounds(draft, limits) {
  let totalBytes = 0;
  let totalDurationMs = 0;
  for (const segment of draft.segments) {
    totalBytes = safeStoredSum(totalBytes, segment.bytes, "segment bytes");
    totalDurationMs = safeStoredSum(totalDurationMs, segment.duration_ms, "segment duration");
  }
  if (
    totalBytes > limits.maxDraftBytes
    || totalDurationMs > limits.maxDraftDurationMs
    || draft.segments.length > limits.maxSegmentsPerDraft
  ) {
    throw statusError(500, "voice draft persisted segment totals exceed configured limits");
  }
  if (draft.audio.total_bytes !== totalBytes || draft.audio.total_duration_ms !== totalDurationMs) {
    throw statusError(500, "voice draft persisted audio totals do not match segments");
  }
}

function safeStoredSum(left, right, field) {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) {
    throw statusError(500, `voice draft stored ${field} arithmetic exceeds safe integer range`);
  }
  return sum;
}

function safeMutationSum(left, right, field) {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) {
    throw statusError(507, `voice draft ${field} capacity exceeds safe integer range`);
  }
  return sum;
}

function validateStoredStateInvariants(draft) {
  const hasCaptureLease = Boolean(draft.capture_lease);
  if (ACTIVE_CAPTURE_STATES.has(draft.state) !== hasCaptureLease) {
    throw statusError(500, `voice draft ${draft.state} state disagrees with capture lease authority`);
  }
  if (draft.recovery_receipt) {
    const recoveryKey = draft.recovery_receipt.idempotency_key;
    const recoveryHash = hashIdempotencyKey(recoveryKey);
    const recoveryHistory = draft.transition_history.find(
      (entry) => entry.idempotency_key_hash === recoveryHash,
    );
    if (
      recoveryHistory
      && (
        recoveryHistory.action !== "park"
        || recoveryHistory.receipt.at !== draft.recovery_receipt.at
        || recoveryHistory.receipt.idempotency_key !== recoveryKey
        || recoveryHistory.request.expected_revision !== draft.recovery_receipt.expected_revision
        || !sameJson(recoveryHistory.receipt.actor, { kind: "system", id: "boot-recovery" })
      )
    ) {
      throw statusError(500, "voice draft recovery history disagrees with recovery receipt");
    }
    if (
      !recoveryKey.startsWith(`recovery-park:${draft.id}:`)
      || !/^\d+$/.test(recoveryKey.slice(`recovery-park:${draft.id}:`.length))
    ) {
      throw statusError(500, "voice draft recovery receipt idempotency authority is invalid");
    }
  }
  if (draft.state === "parked" && !draft.parked_receipt) {
    throw statusError(500, "parked voice draft requires a canonical parked receipt");
  }
  if (draft.state === "parked") {
    assertTerminalHistory(
      draft,
      "park",
      draft.parked_receipt.idempotency_key,
      draft.parked_receipt.at,
      draft.parked_receipt.actor,
    );
  }
  if (draft.send_ready_receipt && !new Set(["send_ready", "sent"]).has(draft.state)) {
    throw statusError(500, "voice draft send-ready receipt is invalid outside send-ready or sent state");
  }
  if (draft.send_ready_receipt) {
    if (draft.send_ready_receipt.audio.content_type !== CANONICAL_CONTENT_TYPE) {
      throw statusError(500, "voice draft send-ready receipt audio is not canonical PCM");
    }
    const expectedAudio = draft.state === "sent" ? draft.tombstone : draft.audio;
    if (
      !expectedAudio
      || draft.send_ready_receipt.audio.bytes !== (
        draft.state === "sent" ? expectedAudio.audio_bytes_discarded : expectedAudio.total_bytes
      )
      || draft.send_ready_receipt.audio.duration_ms !== (
        draft.state === "sent" ? expectedAudio.duration_ms_discarded : expectedAudio.total_duration_ms
      )
      || draft.send_ready_receipt.audio.segment_count !== (
        draft.state === "sent" ? expectedAudio.segment_count_discarded : expectedAudio.segment_count
      )
    ) {
      throw statusError(500, "voice draft send-ready receipt disagrees with persisted audio authority");
    }
  }
  if (draft.cleanup_pending) {
    if (!TERMINAL_STATES.has(draft.state) || draft.cleanup_pending.mode !== draft.state) {
      throw statusError(500, "voice draft cleanup marker disagrees with terminal state");
    }
    assertMatchingTerminalAuthority(draft.cleanup_pending, draft.tombstone, "cleanup marker");
  }
  if (!TERMINAL_STATES.has(draft.state)) {
    if (draft.tombstone || draft.cleanup_pending || draft.sent_receipt || draft.sent_request || draft.discard_receipt) {
      throw statusError(500, "non-terminal voice draft contains terminal authority");
    }
    if (draft.state === "send_ready" && !draft.send_ready_receipt) {
      throw statusError(500, "send-ready voice draft requires a canonical send-ready receipt");
    }
    if (draft.state === "send_ready") {
      assertTerminalHistory(
        draft,
        "send_ready",
        draft.send_ready_receipt.idempotency_key,
        draft.send_ready_receipt.at,
        draft.send_ready_receipt.actor,
      );
    }
    if (draft.claim && draft.state !== "send_ready") {
      throw statusError(500, "voice draft claim is invalid outside send-ready or sent state");
    }
    return;
  }
  if (!isEmptyStoredContent(draft)) {
    throw statusError(500, "terminal voice draft must have empty logical content");
  }
  if (!draft.tombstone || draft.tombstone.mode !== draft.state) {
    throw statusError(500, "terminal voice draft requires a matching tombstone");
  }
  if (draft.state === "sent") {
    if (
      !draft.sent_receipt
      || !draft.sent_request
      || !draft.claim
      || !draft.claim_request
      || !draft.send_ready_receipt
      || draft.discard_receipt
    ) {
      throw statusError(500, "sent voice draft is missing canonical send authority");
    }
    for (const field of ["session_id", "branch_id", "turn_id"]) {
      if (draft.claim[field] !== draft.sent_receipt[field]) {
        throw statusError(500, `sent voice draft claim disagrees with ${field}`);
      }
    }
    assertMatchingTerminalAuthority(draft.sent_receipt, draft.tombstone, "sent tombstone");
    const sentHistory = assertTerminalHistory(
      draft,
      "mark_sent",
      draft.sent_receipt.receipt_id,
      draft.sent_receipt.sent_at,
      draft.sent_receipt.actor,
      draft.sent_request,
    );
    if (
      draft.sent_request.expected_revision !== draft.revision - 1
      || draft.claim_request.expected_revision !== draft.sent_request.expected_revision - 1
      || sentHistory.request.expected_revision !== draft.sent_request.expected_revision
    ) {
      throw statusError(500, "sent voice draft revision authority is contradictory");
    }
  } else {
    if (
      !draft.discard_receipt
      || draft.sent_receipt
      || draft.sent_request
      || draft.claim
      || draft.claim_request
      || draft.send_ready_receipt
    ) {
      throw statusError(500, "discarded voice draft is missing canonical discard authority");
    }
    assertMatchingTerminalAuthority(draft.discard_receipt, draft.tombstone, "discard tombstone");
    const discardHistory = assertTerminalHistory(
      draft,
      "discard",
      draft.discard_receipt.idempotency_key,
      draft.discard_receipt.at,
      draft.discard_receipt.actor,
    );
    if (discardHistory.request.expected_revision !== draft.revision - 1) {
      throw statusError(500, "discarded voice draft revision authority is contradictory");
    }
  }
}

function validateStoredMutationChain(draft) {
  const anchor = draft.mutation_anchor;
  if (
    !anchor
    || anchor.draft_revision !== draft.revision
    || anchor.previous_revision + 1 !== anchor.draft_revision
    || anchor.state !== draft.state
    || anchor.at !== draft.updated_at
  ) {
    throw statusError(500, "voice draft persisted mutation anchor disagrees with current state or revision");
  }

  const latestTransition = draft.transition_history.at(-1) || null;
  if (latestTransition && latestTransition.receipt.state_after !== draft.state) {
    throw statusError(500, "voice draft persisted current state disagrees with the latest transition");
  }

  const predecessorRevisions = new Set();
  let previousSegmentRevision = 0;
  for (const segment of draft.segments) {
    const revision = segment.append_request.expected_revision;
    if (revision <= previousSegmentRevision || revision >= draft.revision || predecessorRevisions.has(revision)) {
      throw statusError(500, "voice draft persisted segment revision chain is contradictory");
    }
    previousSegmentRevision = revision;
    predecessorRevisions.add(revision);
  }
  for (const entry of draft.transition_history) {
    const revision = entry.request.expected_revision;
    if (predecessorRevisions.has(revision)) {
      throw statusError(500, "voice draft persisted mutation predecessors reuse a revision");
    }
    predecessorRevisions.add(revision);
  }
  if (draft.claim_request) {
    const revision = draft.claim_request.expected_revision;
    if (revision >= draft.revision || predecessorRevisions.has(revision)) {
      throw statusError(500, "voice draft persisted claim revision authority is contradictory");
    }
    predecessorRevisions.add(revision);
  }

  let anchoredRequest;
  if (anchor.mutation === "create") {
    if (
      anchor.previous_revision !== 0
      || draft.revision !== DEFAULT_INITIAL_REVISION
      || draft.state !== "capturing"
      || draft.segments.length !== 0
      || draft.transition_history.length !== 0
      || draft.claim_request
    ) {
      throw statusError(500, "voice draft persisted create mutation anchor is contradictory");
    }
    anchoredRequest = draft.create_request;
  } else if (anchor.mutation === "append") {
    const segment = draft.segments.at(-1);
    if (
      !segment
      || segment.append_request.expected_revision !== anchor.previous_revision
      || draft.state !== "capturing"
    ) {
      throw statusError(500, "voice draft persisted append mutation anchor is contradictory");
    }
    anchoredRequest = segment.append_request;
  } else if (anchor.mutation === "transition") {
    if (
      !latestTransition
      || latestTransition.request.expected_revision !== anchor.previous_revision
      || latestTransition.receipt.at !== anchor.at
      || latestTransition.receipt.state_after !== anchor.state
    ) {
      throw statusError(500, "voice draft persisted transition mutation anchor is contradictory");
    }
    anchoredRequest = latestTransition.request;
  } else if (anchor.mutation === "claim") {
    if (
      !draft.claim
      || !draft.claim_request
      || draft.state !== "send_ready"
      || draft.claim_request.expected_revision !== anchor.previous_revision
      || draft.claim.claimed_at !== anchor.at
    ) {
      throw statusError(500, "voice draft persisted claim mutation anchor is contradictory");
    }
    anchoredRequest = draft.claim_request;
  }

  if (!anchoredRequest || digestCanonicalValue(anchoredRequest) !== anchor.request_sha256) {
    throw statusError(500, "voice draft persisted mutation anchor request digest disagrees");
  }
}

function validateStoredAuthorityChain(draft, limits) {
  const chain = draft.authority_chain;
  if (chain.length !== draft.revision || chain.length > maxAuthorityChainEntries(limits)) {
    throw statusError(500, "voice draft authority chain does not cover every revision");
  }
  const createEntry = chain[0];
  if (
    createEntry.operation !== "create"
    || createEntry.at !== draft.created_at
    || createEntry.request_sha256 !== digestCanonicalValue(draft.create_request)
  ) {
    throw statusError(500, "voice draft create authority root disagrees with canonical creation");
  }
  const latest = chain.at(-1);
  if (
    latest.mutation !== draft.mutation_anchor.mutation
    || latest.previous_revision !== draft.mutation_anchor.previous_revision
    || latest.draft_revision !== draft.mutation_anchor.draft_revision
    || latest.state_after !== draft.mutation_anchor.state
    || latest.at !== draft.mutation_anchor.at
    || latest.request_sha256 !== draft.mutation_anchor.request_sha256
    || latest.evidence_sha256 !== digestCanonicalValue(authorityEvidencePayload(draft))
  ) {
    throw statusError(500, "voice draft latest authority chain evidence disagrees with current metadata");
  }

  const userActionHashes = chain
    .filter((entry) => entry.mutation === "transition" && !entry.system_recovery)
    .map((entry) => entry.action_key_hash);
  if (!sameJson(userActionHashes, draft.used_action_key_hashes)) {
    throw statusError(500, "voice draft durable action-key authority disagrees with its mutation chain");
  }

  const appendEntries = chain.filter((entry) => entry.operation === "append");
  const expectedSegmentCount = TERMINAL_STATES.has(draft.state)
    ? draft.tombstone.segment_count_discarded
    : draft.segments.length;
  if (appendEntries.length !== expectedSegmentCount) {
    throw statusError(500, "voice draft segment authority count disagrees with its mutation chain");
  }
  if (!TERMINAL_STATES.has(draft.state)) {
    for (const segment of draft.segments) {
      const entry = chain[segment.append_request.expected_revision];
      if (
        !entry
        || entry.operation !== "append"
        || entry.request_sha256 !== digestCanonicalValue(segment.append_request)
      ) {
        throw statusError(500, "voice draft segment authority disagrees with its global mutation chain");
      }
    }
  }

  for (const history of draft.transition_history) {
    const entry = chain[history.request.expected_revision];
    const recovery = history.request.idempotency_key.startsWith("recovery-park:");
    const operation = history.action === "mark_sent"
      ? "mark_sent"
      : recovery
        ? "recovery_park"
        : history.action;
    if (
      !entry
      || entry.operation !== operation
      || entry.request_sha256 !== digestCanonicalValue(history.request)
      || entry.action_key_hash !== history.idempotency_key_hash
      || entry.state_before !== history.receipt.state_before
      || entry.state_after !== history.receipt.state_after
      || entry.at !== history.receipt.at
    ) {
      throw statusError(500, "voice draft retained transition disagrees with its global mutation chain");
    }
  }

  const claimEntries = chain.filter((entry) => entry.operation === "claim_for_turn");
  if (claimEntries.length > 1) {
    throw statusError(500, "voice draft authority chain contains duplicate turn claims");
  }
  if (draft.claim_request) {
    const claimEntry = chain[draft.claim_request.expected_revision];
    if (
      !claimEntry
      || claimEntry.operation !== "claim_for_turn"
      || claimEntry.at !== draft.claim.claimed_at
      || claimEntry.request_sha256 !== digestCanonicalValue(draft.claim_request)
    ) {
      throw statusError(500, "voice draft claim disagrees with its global mutation chain");
    }
  }

  if (draft.recovery_receipt) {
    const recoveryHash = hashIdempotencyKey(draft.recovery_receipt.idempotency_key);
    const recoveryEntry = chain.find((entry) => (
      entry.operation === "recovery_park"
      && entry.action_key_hash === recoveryHash
    ));
    if (
      !recoveryEntry
      || recoveryEntry.previous_revision !== draft.recovery_receipt.expected_revision
      || recoveryEntry.at !== draft.recovery_receipt.at
    ) {
      throw statusError(500, "voice draft recovery receipt disagrees with its global mutation chain");
    }
  }

  if (TERMINAL_STATES.has(draft.state)) {
    const preContent = latest.pre_content;
    if (
      !preContent
      || preContent.bytes !== draft.tombstone.audio_bytes_discarded
      || preContent.duration_ms !== draft.tombstone.duration_ms_discarded
      || preContent.segment_count !== draft.tombstone.segment_count_discarded
    ) {
      throw statusError(500, "voice draft tombstone disagrees with anchored pre-cleanup content");
    }
  }
}

function authorityEvidencePayload(draft) {
  const excluded = new Set([
    "capture_lease",
    "mutation_anchor",
    "authority_chain",
    "cleanup_pending",
  ]);
  const payload = {};
  for (const field of STORED_DRAFT_FIELDS) {
    if (excluded.has(field)) continue;
    payload[field] = clone(draft[field]);
  }
  return payload;
}

function currentContentAuthority(draft) {
  return {
    bytes: draft.audio.total_bytes,
    duration_ms: draft.audio.total_duration_ms,
    segment_count: draft.audio.segment_count,
    audio_sha256: draft.audio.sha256,
    segments_sha256: digestCanonicalValue(draft.segments),
    partial_transcript_sha256: digestBytes(Buffer.from(draft.partial_transcript, "utf8")),
    partial_transcript_updated_at: draft.partial_transcript_updated_at,
  };
}

function authorityChainEntryDigestPayload(entry) {
  const payload = {};
  for (const field of AUTHORITY_CHAIN_FIELDS) {
    if (field === "chain_sha256") continue;
    payload[field] = clone(entry[field]);
  }
  return payload;
}

function appendMutationAuthority(draft, input) {
  setMutationAnchor(
    draft,
    input.mutation,
    input.request,
    input.at,
    input.previousRevision === undefined ? draft.revision - 1 : input.previousRevision,
  );
  const previous = draft.authority_chain.at(-1) || null;
  const entry = {
    type: "voice_draft_authority_chain_entry",
    revision: STATE_MACHINE_REVISION,
    draft_id: draft.id,
    mutation: input.mutation,
    operation: input.operation,
    previous_revision: draft.mutation_anchor.previous_revision,
    draft_revision: draft.revision,
    state_before: input.stateBefore,
    state_after: draft.state,
    at: input.at,
    request_sha256: draft.mutation_anchor.request_sha256,
    action_key_hash: input.actionKeyHash || "",
    system_recovery: Boolean(input.systemRecovery),
    pre_content: input.preContent ? clone(input.preContent) : null,
    evidence_sha256: digestCanonicalValue(authorityEvidencePayload(draft)),
    previous_chain_sha256: previous?.chain_sha256 || "",
    chain_sha256: "",
  };
  entry.chain_sha256 = digestCanonicalValue(authorityChainEntryDigestPayload(entry));
  draft.authority_chain = [...draft.authority_chain, entry];
}

function isEmptyStoredContent(draft) {
  return draft.partial_transcript === ""
    && draft.segments.length === 0
    && draft.audio.content_type === ""
    && draft.audio.encoding === ""
    && draft.audio.total_bytes === 0
    && draft.audio.total_duration_ms === 0
    && draft.audio.segment_count === 0
    && draft.audio.sha256 === "";
}

function assertMatchingTerminalAuthority(authority, tombstone, label) {
  if (
    !authority
    || !tombstone
    || (authority.at || authority.sent_at) !== tombstone.at
    || !sameJson(authority.actor, tombstone.actor)
    || (authority.receipt_id || authority.idempotency_key) !== tombstone.receipt_id
  ) {
    throw statusError(500, `voice draft ${label} authority disagrees`);
  }
}

function assertTerminalHistory(draft, action, key, at, actor, expectedRequest = null) {
  const keyHash = hashIdempotencyKey(key);
  const entry = draft.transition_history.find((item) => item.idempotency_key_hash === keyHash);
  const hasDurableAuthority = draft.used_action_key_hashes.includes(keyHash)
    || draft.recovery_receipt?.idempotency_key === key;
  if (
    !entry
    || entry.action !== action
    || entry.receipt.at !== at
    || !sameJson(entry.receipt.actor, actor)
    || !hasDurableAuthority
  ) {
    throw statusError(500, `voice draft terminal ${action} history authority is missing`);
  }
  if (expectedRequest && !sameJson(entry.request, expectedRequest)) {
    throw statusError(500, `voice draft terminal ${action} request authority disagrees`);
  }
  return entry;
}

function storedRequiredObject(value, field) {
  if (!isPlainObject(value)) {
    throw statusError(500, `voice draft stored ${field} must be an object`);
  }
  return clone(value);
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function assertNoUnknownStoredFields(value, allowedFields, field) {
  const allowed = new Set(allowedFields);
  const unknown = Object.keys(value || {}).filter((name) => !allowed.has(name));
  if (unknown.length > 0) {
    throw statusError(500, `voice draft stored ${field} contains ${unknown.length} unknown fields`);
  }
}

function assertAllStoredFieldsPresent(value, requiredFields, field) {
  const missing = requiredFields.filter((name) => !Object.prototype.hasOwnProperty.call(value || {}, name));
  if (missing.length > 0) {
    throw statusError(500, `voice draft stored ${field} is missing required fields: ${missing.join(", ")}`);
  }
}

function assertExactStoredFields(value, fields, field) {
  assertNoUnknownStoredFields(value, fields, field);
  assertAllStoredFieldsPresent(value, fields, field);
}

function hasExactFields(value, fields) {
  if (!isPlainObject(value)) return false;
  const expected = new Set(fields);
  const actual = Object.keys(value);
  return actual.length === expected.size && actual.every((name) => expected.has(name));
}

function normalizeStoredAppendRequest(request, segment, expectedDraftId = "") {
  if (!isPlainObject(request)) {
    throw statusError(500, "voice draft persisted append request is invalid");
  }
  assertExactStoredFields(request, [
    "type",
    "revision",
    "draft_id",
    "segment_id",
    "expected_revision",
    "content_type",
    "duration_ms",
    "bytes",
    "sha256",
    "declared_byte_count",
    "declared_sha256",
    "partial_transcript_sha256",
  ], "append_request");
  if (
    request.type !== "voice_draft_append_request"
    || request.revision !== STATE_MACHINE_REVISION
    || (expectedDraftId && request.draft_id !== expectedDraftId)
    || request.segment_id !== segment.segment_id
  ) {
    throw statusError(500, "voice draft persisted append request authority is invalid");
  }
  const draftId = requireStoredAuthorityToken(request.draft_id, "append_request.draft_id");
  const expectedRevision = requireStoredPositiveInteger(
    request.expected_revision,
    "append_request.expected_revision",
  );
  const durationMs = requireStoredNonNegativeInteger(request.duration_ms, "append_request.duration_ms");
  const byteCount = requireStoredPositiveInteger(request.bytes, "append_request.bytes");
  const digest = requireStoredDigest(request.sha256, "append_request.sha256", false);
  if (
    request.content_type !== segment.content_type
    || durationMs !== segment.duration_ms
    || byteCount !== segment.bytes
    || digest !== segment.sha256
  ) {
    throw statusError(500, "voice draft persisted append request disagrees with segment metadata");
  }
  let declaredByteCount = null;
  if (request.declared_byte_count !== null) {
    declaredByteCount = requireStoredNonNegativeInteger(
      request.declared_byte_count,
      "append_request.declared_byte_count",
    );
    if (declaredByteCount !== segment.bytes) {
      throw statusError(500, "voice draft persisted append byte declaration disagrees");
    }
  }
  let declaredDigest = null;
  if (request.declared_sha256 !== null) {
    declaredDigest = requireStoredDigest(request.declared_sha256, "append_request.declared_sha256", false);
    if (declaredDigest !== segment.sha256) {
      throw statusError(500, "voice draft persisted append digest declaration disagrees");
    }
  }
  return {
    type: request.type,
    revision: request.revision,
    draft_id: draftId,
    segment_id: requireStoredAuthorityToken(request.segment_id, "append_request.segment_id"),
    expected_revision: expectedRevision,
    content_type: requireStoredText(request.content_type, "append_request.content_type"),
    duration_ms: durationMs,
    bytes: byteCount,
    sha256: digest,
    declared_byte_count: declaredByteCount,
    declared_sha256: declaredDigest,
    partial_transcript_sha256: requireStoredDigest(
      request.partial_transcript_sha256,
      "append_request.partial_transcript_sha256",
      true,
    ),
  };
}

function validateStoredAppendRequest(request, draftId, segment) {
  normalizeStoredAppendRequest(request, segment, draftId);
}

function pathEntryExists(filePath) {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
}

function assertDirectoryBoundary(dirPath, label) {
  let stat;
  try {
    stat = fs.lstatSync(dirPath);
  } catch (error) {
    throw statusError(500, `${label} is unavailable: ${error.message}`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw statusError(500, `${label} must be a non-symlink directory`);
  }
  return stat;
}

function ensurePrivateDirectory(dirPath, label) {
  try {
    fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw statusError(500, `${label} could not be created: ${error.message}`);
  }
  assertDirectoryBoundary(dirPath, label);
  try {
    fs.chmodSync(dirPath, 0o700);
  } catch (error) {
    throw statusError(500, `${label} permissions could not be restricted: ${error.message}`);
  }
}

function assertRegularFile(filePath, label) {
  assertDirectoryBoundary(path.dirname(filePath), `${label} parent directory`);
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    throw statusError(500, `${label} is unavailable: ${error.message}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw statusError(500, `${label} must be a non-symlink regular file`);
  }
  return stat;
}

function openRegularFile(filePath, flags, label, mode) {
  const parentBefore = assertDirectoryBoundary(path.dirname(filePath), `${label} parent directory`);
  if (pathEntryExists(filePath)) {
    assertRegularFile(filePath, label);
  }
  const noFollow = Number(fs.constants.O_NOFOLLOW || 0);
  let fd;
  try {
    fd = fs.openSync(filePath, flags | noFollow, mode);
  } catch (error) {
    throw statusError(500, `${label} could not be opened safely: ${error.message}`);
  }
  const stat = fs.fstatSync(fd);
  if (!stat.isFile()) {
    fs.closeSync(fd);
    throw statusError(500, `${label} must be a regular file`);
  }
  const parentAfter = assertDirectoryBoundary(path.dirname(filePath), `${label} parent directory`);
  if (!sameFileIdentity(parentBefore, parentAfter)) {
    fs.closeSync(fd);
    throw statusError(500, `${label} parent directory changed while opening the file`);
  }
  return fd;
}

function removeRegularFileVerified(filePath, label) {
  const parentBefore = assertDirectoryBoundary(path.dirname(filePath), `${label} parent directory`);
  if (!pathEntryExists(filePath)) {
    return;
  }
  assertRegularFile(filePath, label);
  try {
    const parentCurrent = assertDirectoryBoundary(path.dirname(filePath), `${label} parent directory`);
    if (!sameFileIdentity(parentBefore, parentCurrent)) {
      throw statusError(500, `${label} parent directory changed before removal`);
    }
    fs.unlinkSync(filePath);
  } catch (error) {
    throw statusError(500, `${label} could not be removed: ${error.message}`);
  }
  fsyncDirectory(path.dirname(filePath), `${label} directory`);
  if (pathEntryExists(filePath)) {
    throw statusError(500, `${label} still exists after removal`);
  }
}

function removeAtomicWriteTemps(draftDir) {
  if (!pathEntryExists(draftDir)) return;
  assertDirectoryBoundary(draftDir, "voice draft directory");
  for (const entry of fs.readdirSync(draftDir, { withFileTypes: true })) {
    if (!ATOMIC_TMP_PATTERN.test(entry.name)) continue;
    const tempPath = safeChildPath(draftDir, entry.name, "voice draft atomic-write temp");
    removeRegularFileVerified(tempPath, "voice draft atomic-write temp");
  }
}

function removeReplayIndexTemps(draftsDir) {
  assertStoreBoundary(draftsDir);
  for (const entry of fs.readdirSync(draftsDir, { withFileTypes: true })) {
    if (!REPLAY_INDEX_TMP_PATTERN.test(entry.name)) continue;
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw statusError(500, `voice draft replay index temp ${entry.name} must be a regular file`);
    }
    removeRegularFileVerified(
      path.join(draftsDir, entry.name),
      "voice draft expired replay index temp",
    );
  }
}

function readExactDraftDirectoryEntries(draftsDir, draftId, label) {
  const before = assertDraftBoundary(draftsDir, draftId, label);
  const draftDir = draftDirForId(draftsDir, draftId);
  const entries = fs.readdirSync(draftDir, { withFileTypes: true });
  const after = assertDraftBoundary(draftsDir, draftId, label);
  assertSameBoundary(before, after, label);
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw statusError(500, `voice draft ${draftId} contains forbidden ${entry.name}; files must be non-symlink regular files`);
    }
  }
  return entries.map((entry) => entry.name).sort();
}

function assertKnownDraftDirectoryScaffolding(draftsDir, draftId, label) {
  const known = new Set([META_FILE, DRAFT_LOCK_FILE, CANONICAL_AUDIO_FILE, JOURNAL_FILE]);
  const unexpected = readExactDraftDirectoryEntries(draftsDir, draftId, label)
    .filter((name) => !known.has(name) && !ATOMIC_TMP_PATTERN.test(name));
  if (unexpected.length > 0) {
    throw statusError(
      500,
      `voice draft ${draftId} contains unexpected files: ${unexpected.join(", ")}`,
    );
  }
}

function assertExactDraftDirectory(draftsDir, record, options = {}) {
  const draftId = record.kind === EXPIRED_REPLAY_KIND ? record.draft_id : record.id;
  const names = readExactDraftDirectoryEntries(draftsDir, draftId, "voice draft physical schema");
  const allowed = new Set([META_FILE, DRAFT_LOCK_FILE]);
  if (record.kind === STORE_KIND) {
    const journalPresent = names.includes(JOURNAL_FILE);
    if (!TERMINAL_STATES.has(record.state) || record.cleanup_pending) {
      if (journalPresent && (APPENDABLE_STATES.has(record.state) || record.cleanup_pending)) {
        allowed.add(JOURNAL_FILE);
      }
      if (record.audio.total_bytes > 0 || record.cleanup_pending || journalPresent) {
        allowed.add(CANONICAL_AUDIO_FILE);
      }
    }
    if (
      record.audio.total_bytes > 0
      && !record.cleanup_pending
      && !names.includes(CANONICAL_AUDIO_FILE)
    ) {
      throw statusError(500, `voice draft ${draftId} physical schema is missing ${CANONICAL_AUDIO_FILE}`);
    }
  }
  const unexpected = names.filter((name) => (
    !allowed.has(name)
    && !(options.allowAtomicTemps && ATOMIC_TMP_PATTERN.test(name))
  ));
  if (unexpected.length > 0) {
    throw statusError(
      500,
      `voice draft ${draftId} physical schema contains unexpected files: ${unexpected.join(", ")}`,
    );
  }
  if (!names.includes(META_FILE)) {
    throw statusError(500, `voice draft ${draftId} physical schema is missing ${META_FILE}`);
  }
  if (names.includes(DRAFT_LOCK_FILE)) {
    const lockPath = path.join(draftDirForId(draftsDir, draftId), DRAFT_LOCK_FILE);
    const lockStat = assertRegularFile(lockPath, `voice draft ${draftId} operation lock`);
    if (!Number.isSafeInteger(lockStat.size) || lockStat.size > MAX_OWNER_RECORD_BYTES) {
      throw statusError(500, `voice draft ${draftId} operation lock exceeds ${MAX_OWNER_RECORD_BYTES} bytes`);
    }
    const snapshot = readOwnerSnapshot(lockPath, `voice draft ${draftId} operation lock`);
    if (
      !snapshot.record
      || snapshot.record.type !== "voice_draft_operation_lock"
      || snapshot.record.label !== draftId
    ) {
      if (!options.allowRecoverableLock) {
        throw statusError(500, `voice draft ${draftId} operation lock scaffolding is invalid`);
      }
    }
  }
}

function assertContentArtifactsAbsent(draftsDir, draftId) {
  assertDraftBoundary(draftsDir, draftId, "voice draft content-absence check");
  const draftDir = draftDirForId(draftsDir, draftId);
  for (const fileName of [CANONICAL_AUDIO_FILE, JOURNAL_FILE]) {
    if (pathEntryExists(safeChildPath(draftDir, fileName, "voice draft content artifact"))) {
      throw statusError(500, `voice draft ${draftId} cleanup left ${fileName}`);
    }
  }
  const leftoverTemp = fs.readdirSync(draftDir).find((name) => ATOMIC_TMP_PATTERN.test(name));
  if (leftoverTemp) {
    throw statusError(500, `voice draft ${draftId} cleanup left atomic temp ${leftoverTemp}`);
  }
  const unexpected = readExactDraftDirectoryEntries(
    draftsDir,
    draftId,
    "voice draft content-absence check",
  ).filter((name) => !new Set([META_FILE, DRAFT_LOCK_FILE]).has(name));
  if (unexpected.length > 0) {
    throw statusError(
      500,
      `voice draft ${draftId} cleanup left unexpected files: ${unexpected.join(", ")}`,
    );
  }
}

function assertNoOrphanContent(draftsDir, draftId) {
  assertDraftBoundary(draftsDir, draftId, "orphan voice draft directory");
  const draftDir = draftDirForId(draftsDir, draftId);
  for (const fileName of [CANONICAL_AUDIO_FILE, JOURNAL_FILE]) {
    if (pathEntryExists(safeChildPath(draftDir, fileName, "orphan voice draft content"))) {
      throw statusError(500, `voice draft ${draftId} has content without authoritative metadata`);
    }
  }
}

function assertNoUnexpectedOrphanFiles(draftsDir, draftId, options = {}) {
  assertDraftBoundary(draftsDir, draftId, "orphan voice draft directory");
  const draftDir = draftDirForId(draftsDir, draftId);
  const unexpected = fs.readdirSync(draftDir).filter((name) => (
    name !== DRAFT_LOCK_FILE
    && !(options.allowAtomicTemps && ATOMIC_TMP_PATTERN.test(name))
  ));
  if (unexpected.length > 0) {
    throw statusError(
      500,
      `voice draft ${draftId} has files without authoritative metadata: ${unexpected.join(", ")}`,
    );
  }
}

function removeEmptyDraftDirectory(draftsDir, draftId) {
  assertStoreBoundary(draftsDir);
  const draftDir = draftDirForId(draftsDir, draftId);
  if (!pathEntryExists(draftDir)) return false;
  assertDirectoryBoundary(draftDir, "empty voice draft directory");
  if (fs.readdirSync(draftDir).length > 0) return false;
  try {
    fs.rmdirSync(draftDir);
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    if (error && error.code === "ENOTEMPTY") return false;
    throw statusError(500, `empty voice draft directory could not be removed: ${error.message}`);
  }
  fsyncDirectory(draftsDir, "voice draft store");
  return true;
}

function safeChildPath(parentDir, childName, label) {
  const resolvedParent = path.resolve(parentDir);
  const resolvedChild = path.resolve(resolvedParent, childName);
  const relative = path.relative(resolvedParent, resolvedChild);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw statusError(500, `${label} resolved outside the draft directory`);
  }
  return resolvedChild;
}

function atomicWrite(filePath, value, boundaryVerifier = null, testHooks = null, label = "voice draft") {
  const verifyBoundary = boundaryVerifier || (() => ({
    stat: assertDirectoryBoundary(path.dirname(filePath), "voice draft atomic-write directory"),
  }));
  const beforeBoundary = verifyBoundary();
  if (pathEntryExists(filePath)) {
    assertRegularFile(filePath, "voice draft atomic-write target");
  }
  const tmpPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  const fd = openRegularFile(
    tmpPath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
    "voice draft atomic-write temp",
    0o600,
  );
  let renamed = false;
  let publicationState = "not_published";
  try {
    try {
      fs.writeFileSync(fd, value);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const beforeRenameBoundary = verifyBoundary();
    assertSameBoundary(beforeBoundary, beforeRenameBoundary, "voice draft atomic write");
    fs.renameSync(tmpPath, filePath);
    renamed = true;
    publicationState = "publication_durability_unknown";
    try {
      runHook(testHooks, "beforeAtomicParentFsync", { filePath, label });
      fsyncDirectory(path.dirname(filePath), "voice draft atomic-write directory");
      publicationState = "published_verified";
    } catch (firstDurabilityError) {
      const afterRenameBoundary = verifyBoundary();
      assertSameBoundary(beforeBoundary, afterRenameBoundary, "voice draft atomic write");
      const publishedFd = openRegularFile(
        filePath,
        fs.constants.O_RDONLY,
        "voice draft ambiguous atomic-write target",
      );
      let published;
      try {
        published = fs.readFileSync(publishedFd, { encoding: "utf8" });
      } finally {
        fs.closeSync(publishedFd);
      }
      if (published !== String(value)) {
        const mismatch = statusError(500, "voice draft atomic publication is ambiguous and target bytes disagree");
        mismatch.code = "voice_draft_publication_durability_unknown";
        mismatch.publication_state = publicationState;
        throw mismatch;
      }
      try {
        runHook(testHooks, "beforeAtomicParentFsyncReconcile", { filePath, label });
        fsyncDirectory(path.dirname(filePath), "voice draft atomic-write reconciliation directory");
        publicationState = "published_verified";
      } catch (reconciliationError) {
        const unknown = statusError(
          500,
          `voice draft atomic publication durability remains unknown: ${reconciliationError.message}`,
        );
        unknown.code = "voice_draft_publication_durability_unknown";
        unknown.publication_state = publicationState;
        unknown.published_value_verified = true;
        unknown.cause = firstDurabilityError;
        throw unknown;
      }
    }
  } catch (error) {
    if (!error.publication_state) {
      error.publication_state = renamed ? publicationState : "not_published";
    }
    throw error;
  } finally {
    if (!renamed && pathEntryExists(tmpPath)) {
      removeRegularFileVerified(tmpPath, "voice draft failed atomic-write temp");
    }
  }
  try {
    const afterBoundary = verifyBoundary();
    assertSameBoundary(beforeBoundary, afterBoundary, "voice draft atomic write");
    assertRegularFile(filePath, "voice draft atomic-write result");
  } catch (error) {
    error.publication_state = publicationState;
    throw error;
  }
  return { publication_state: publicationState };
}

function fsyncDirectory(dirPath, label) {
  assertDirectoryBoundary(dirPath, label);
  let fd;
  try {
    fd = fs.openSync(dirPath, fs.constants.O_RDONLY);
    fs.fsyncSync(fd);
  } catch (error) {
    throw statusError(500, `${label} could not be synchronized: ${error.message}`);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function bumpRevision(draft) {
  const current = requireStoredPositiveInteger(draft.revision, "revision");
  if (current >= Number.MAX_SAFE_INTEGER) {
    throw statusError(507, "voice draft revision capacity exceeded");
  }
  draft.revision = current + 1;
}

function setMutationAnchor(draft, mutation, request, at, previousRevision = draft.revision - 1) {
  draft.mutation_anchor = {
    type: "voice_draft_mutation_anchor",
    revision: STATE_MACHINE_REVISION,
    mutation,
    previous_revision: previousRevision,
    draft_revision: draft.revision,
    state: draft.state,
    at,
    request_sha256: digestCanonicalValue(request),
  };
}

function digestCanonicalValue(value) {
  return digestBytes(Buffer.from(JSON.stringify(value), "utf8"));
}

function digestBytes(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function digestDraftFile(draftsDir, draftId, filePath, label) {
  const fd = openDraftFile(draftsDir, draftId, filePath, fs.constants.O_RDONLY, label);
  try {
    return digestFd(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function readVerifiedAudioSnapshot(
  draftsDir,
  draft,
  audioPath,
  expectedBoundary,
  expectedIdentity,
  testHooks,
  mode,
) {
  const fd = openDraftFile(
    draftsDir,
    draft.id,
    audioPath,
    fs.constants.O_RDONLY,
    "voice draft audio snapshot",
    undefined,
    expectedBoundary,
  );
  try {
    const openedIdentity = fs.fstatSync(fd);
    if (!sameFileIdentity(openedIdentity, expectedIdentity)) {
      throw statusError(500, `voice draft ${draft.id} PCM inode changed before ${mode}`);
    }
    if (openedIdentity.size !== draft.audio.total_bytes) {
      throw statusError(500, `voice draft ${draft.id} PCM size changed before ${mode}`);
    }
    const bytes = fs.readFileSync(fd);
    runHook(testHooks, "afterAudioSnapshotReadBeforeVerify", {
      draftId: draft.id,
      mode,
      audioPath,
    });
    if (bytes.length !== draft.audio.total_bytes) {
      throw statusError(500, `voice draft ${draft.id} PCM size changed while creating ${mode} snapshot`);
    }
    if (digestBytes(bytes) !== draft.audio.sha256) {
      throw statusError(500, `voice draft ${draft.id} PCM digest changed before ${mode}`);
    }
    const finalBoundary = assertDraftBoundary(draftsDir, draft.id, `voice draft audio ${mode} snapshot`);
    assertSameBoundary(expectedBoundary, finalBoundary, `voice draft audio ${mode} snapshot`);
    const finalIdentity = assertRegularFile(audioPath, `voice draft audio ${mode} snapshot`);
    if (
      !sameFileIdentity(finalIdentity, openedIdentity)
      || finalIdentity.size !== draft.audio.total_bytes
    ) {
      throw statusError(500, `voice draft ${draft.id} PCM path changed while creating ${mode} snapshot`);
    }
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}

function digestFd(fd) {
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let bytesRead = 0;
  let position = 0;
  do {
    bytesRead = fs.readSync(fd, buffer, 0, buffer.length, position);
    if (bytesRead > 0) {
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } while (bytesRead > 0);
  return hash.digest("hex");
}

function digestFdRange(fd, offset, length) {
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, length)));
  let consumed = 0;
  while (consumed < length) {
    const requested = Math.min(buffer.length, length - consumed);
    const bytesRead = fs.readSync(fd, buffer, 0, requested, offset + consumed);
    if (bytesRead !== requested) {
      throw statusError(500, "voice draft PCM segment changed while verifying its digest");
    }
    hash.update(buffer.subarray(0, bytesRead));
    consumed += bytesRead;
  }
  return hash.digest("hex");
}

function hashIdempotencyKey(key) {
  return crypto.createHash("sha256").update(String(key)).digest("hex");
}

function createDraftId() {
  return `draft_${Date.now().toString(36)}_${crypto.randomBytes(6).toString("hex")}`;
}

function stripLeaseEvidence(lease) {
  if (!lease) return null;
  return {
    draft_id: lease.draft_id,
    lease_id: lease.lease_id,
    owner_id: lease.owner_id,
    pid: lease.pid,
    process_boot_id: lease.process_boot_id,
  };
}

function summarizeEvent(type, draft, detail) {
  return {
    type,
    draft_id: draft.id,
    state: draft.state,
    detail: clone(detail),
  };
}

function safeMirror(fn, event) {
  try {
    const result = fn(event);
    if (result && typeof result.then === "function") {
      result.catch(() => {});
    }
  } catch {
    // Event mirroring is additive only; storage remains authoritative.
  }
}

function runHook(testHooks, name, context) {
  if (!name || !testHooks || typeof testHooks[name] !== "function") {
    return;
  }
  testHooks[name](context);
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function assertExactStoreRoot(draftsDir, limits = null) {
  const maxReplayBytes = limits?.maxReplayIndexBytes || DEFAULT_MAX_REPLAY_INDEX_BYTES;
  const before = assertStoreBoundary(draftsDir);
  const entries = fs.readdirSync(draftsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw statusError(500, `voice draft store contains forbidden symlink ${entry.name}`);
    }
    if (entry.isDirectory()) {
      try {
        requireExactToken(entry.name, "draft_id", DEFAULT_MAX_CORRELATION_LENGTH);
      } catch (error) {
        throw statusError(500, `voice draft store contains invalid draft directory ${entry.name}: ${error.message}`);
      }
      continue;
    }
    if (!entry.isFile()) {
      throw statusError(500, `voice draft store contains forbidden special entry ${entry.name}`);
    }
    const filePath = path.join(draftsDir, entry.name);
    const size = assertRegularFile(filePath, `voice draft store root ${entry.name}`).size;
    if (entry.name === STORE_LOCK_FILE || entry.name === CAPTURE_LOCK_FILE) {
      if (!Number.isSafeInteger(size) || size > MAX_OWNER_RECORD_BYTES) {
        throw statusError(500, `voice draft store owner ${entry.name} exceeds ${MAX_OWNER_RECORD_BYTES} bytes`);
      }
      continue;
    }
    if (entry.name === REPLAY_INDEX_FILE || REPLAY_INDEX_TMP_PATTERN.test(entry.name)) {
      if (!Number.isSafeInteger(size) || size > maxReplayBytes) {
        throw statusError(500, `voice draft replay index artifact ${entry.name} exceeds ${maxReplayBytes} bytes`);
      }
      continue;
    }
    throw statusError(500, `voice draft store contains unexpected root file ${entry.name}`);
  }
  const after = assertStoreBoundary(draftsDir);
  assertSameBoundary(before, after, "voice draft store root inspection");
  return entries;
}

function inspectPhysicalStoreUsage(draftsDir, limits) {
  const rootEntries = assertExactStoreRoot(draftsDir, limits);
  let rootFileBytes = 0;
  let rootFileCount = 0;
  let draftFileBytes = 0;
  let draftFileCount = 0;
  let draftDirectoryCount = 0;
  for (const entry of rootEntries) {
    const entryPath = path.join(draftsDir, entry.name);
    if (entry.isFile()) {
      rootFileBytes = safeStoredSum(
        rootFileBytes,
        assertRegularFile(entryPath, `voice draft store root ${entry.name}`).size,
        "root physical bytes",
      );
      rootFileCount += 1;
      continue;
    }
    if (!entry.isDirectory()) continue;
    draftDirectoryCount += 1;
    const boundaryBefore = assertDraftBoundary(draftsDir, entry.name, "voice draft physical accounting");
    for (const child of fs.readdirSync(entryPath, { withFileTypes: true })) {
      if (child.isSymbolicLink() || !child.isFile()) {
        throw statusError(500, `voice draft ${entry.name} contains an unaccountable physical entry ${child.name}`);
      }
      draftFileBytes = safeStoredSum(
        draftFileBytes,
        assertRegularFile(
          path.join(entryPath, child.name),
          `voice draft ${entry.name} physical ${child.name}`,
        ).size,
        "draft physical bytes",
      );
      draftFileCount += 1;
    }
    const boundaryAfter = assertDraftBoundary(draftsDir, entry.name, "voice draft physical accounting");
    assertSameBoundary(boundaryBefore, boundaryAfter, "voice draft physical accounting");
  }
  return {
    root_file_count: rootFileCount,
    root_file_bytes: rootFileBytes,
    draft_directory_count: draftDirectoryCount,
    draft_file_count: draftFileCount,
    draft_file_bytes: draftFileBytes,
    total_entry_count: rootFileCount + draftDirectoryCount + draftFileCount,
    total_bytes: safeStoredSum(rootFileBytes, draftFileBytes, "physical store bytes"),
  };
}

function listDraftDirectoryIds(draftsDir) {
  if (!pathEntryExists(draftsDir)) return [];
  const entries = assertExactStoreRoot(draftsDir);
  const ids = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    ids.push(entry.name);
  }
  return ids.sort();
}

function listAuthoritativeDraftIds(draftsDir) {
  return listDraftDirectoryIds(draftsDir).filter((draftId) => pathEntryExists(metadataPathForDraft(draftsDir, draftId)));
}

function statusError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

module.exports = {
  ACTIVE_CAPTURE_STATES,
  LEGAL_TRANSITIONS,
  STATE_MACHINE_REVISION,
  STORE_REVISION,
  createVoiceDraftStore,
};
