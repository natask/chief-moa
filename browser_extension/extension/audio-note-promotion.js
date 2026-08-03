const CAPTURE_BLOCKS_PATH = "/v1/capture-blocks";
const PROMOTION_STORAGE_PREFIX = "ageeAudioNotePromotion:";

function cleanText(value, max = 240) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function requireNoteId(note) {
  const id = cleanText(note?.id, 120);
  if (!id) throw new Error("Audio note identity is missing.");
  return id;
}

function promotionStorageKey(note) {
  return `${PROMOTION_STORAGE_PREFIX}${encodeURIComponent(requireNoteId(note))}`;
}

function captureBlockPath(blockId) {
  const id = cleanText(blockId, 160);
  if (!/^cap_[a-f0-9]{64}$/.test(id)) throw new Error("Capture block identity is invalid.");
  return `${CAPTURE_BLOCKS_PATH}/${encodeURIComponent(id)}`;
}

function captureBlockHandoffPath(blockId) {
  return `${captureBlockPath(blockId)}/handoff`;
}

function captureBlockRetryPath(blockId) {
  return `${captureBlockPath(blockId)}/retry`;
}

function newPromotionRecord(note, createId = () => globalThis.crypto.randomUUID()) {
  const noteId = requireNoteId(note);
  const idempotencyKey = cleanText(createId(), 48);
  if (!idempotencyKey) throw new Error("Could not create a promotion identity.");
  return {
    schema_version: 1,
    audio_note_id: noteId,
    idempotency_key: `browser-audio-note:${noteId}:${idempotencyKey}`,
    capture_block_id: null,
    snapshot: null,
    handoff: null,
  };
}

function usablePromotionRecord(note, value) {
  const noteId = requireNoteId(note);
  if (!value || value.schema_version !== 1 || value.audio_note_id !== noteId) return null;
  const idempotencyKey = cleanText(value.idempotency_key, 200);
  if (!idempotencyKey) return null;
  const storedBlockId = /^cap_[a-f0-9]{64}$/.test(value.capture_block_id || "")
    ? value.capture_block_id
    : null;
  const snapshot = usablePromotionSnapshot(noteId, storedBlockId, value.snapshot);
  const captureBlockId = snapshot ? storedBlockId : null;
  const handoff = value.handoff && typeof value.handoff === "object"
    && value.handoff.source_record_id === captureBlockId
    && cleanText(value.handoff.admission_id, 160)
    && /^capture-block-v2:[a-f0-9]{64}$/.test(value.handoff.source_revision || "")
    && /^sha256:[a-f0-9]{64}$/.test(value.handoff.request_digest || "")
    && Array.isArray(value.handoff.compiled_intent_ids)
    ? value.handoff
    : null;
  return {
    schema_version: 1,
    audio_note_id: noteId,
    idempotency_key: idempotencyKey,
    capture_block_id: captureBlockId,
    snapshot,
    handoff,
  };
}

function usablePromotionSnapshot(noteId, captureBlockId, value) {
  if (!captureBlockId || !value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.capture_block_id !== captureBlockId || value.audio_note_id !== noteId) return null;
  const processingState = cleanText(value.processing_state, 60).toLowerCase();
  const transcriptState = cleanText(value.transcript_state, 60).toLowerCase();
  const allowed = new Set(["queued", "transcribing", "transcribed", "failed"]);
  if (!allowed.has(processingState) || !allowed.has(transcriptState)) return null;
  return {
    capture_block_id: captureBlockId,
    audio_note_id: noteId,
    processing_state: processingState,
    transcript_state: transcriptState,
    literal_transcript: typeof value.literal_transcript === "string"
      ? value.literal_transcript.slice(0, 4000)
      : "",
    transcript_result_id: cleanText(value.transcript_result_id, 160),
    transcript_provider_id: cleanText(value.transcript_provider_id, 120),
    transcript_provider_request_id: cleanText(value.transcript_provider_request_id, 160),
    failure_message: cleanText(value.failure_message, 300),
    retryable: value.retryable === true,
  };
}

function captureBlockRequest(note, record) {
  return {
    audio_note_id: requireNoteId(note),
    idempotency_key: record.idempotency_key,
    source: {
      surface: cleanText(note?.surface, 80),
      session_id: cleanText(note?.session_id, 160),
      capture_id: cleanText(note?.capture_id, 160),
    },
  };
}

function captureBlockSnapshot(payload) {
  const block = payload?.capture_block || payload;
  const blockId = cleanText(block?.id, 160);
  const noteId = cleanText(block?.source?.audio_note_id || block?.audio?.audio_note_id, 120);
  if (!/^cap_[a-f0-9]{64}$/.test(blockId) || !noteId) {
    throw new Error("Gateway returned an invalid capture block.");
  }
  const transcript = block.transcript && typeof block.transcript === "object" ? block.transcript : {};
  const failure = block.failure && typeof block.failure === "object" ? block.failure : {};
  const processingEvents = Array.isArray(block.processing_events) ? block.processing_events : [];
  const latestProcessing = processingEvents.at(-1) || {};
  return {
    capture_block_id: blockId,
    audio_note_id: noteId,
    processing_state: cleanText(latestProcessing.to_state || block.processing_state || transcript.state || "queued", 60).toLowerCase(),
    transcript_state: cleanText(transcript.state || block.processing_state || "queued", 60).toLowerCase(),
    literal_transcript: typeof block.literal_transcript === "string"
      ? block.literal_transcript.slice(0, 4000)
      : typeof transcript.literal === "string" ? transcript.literal.slice(0, 4000) : "",
    transcript_result_id: cleanText(transcript.result_id, 160),
    transcript_provider_id: cleanText(transcript.provider?.id, 120),
    transcript_provider_request_id: cleanText(transcript.provider?.request_id, 160),
    failure_message: cleanText(failure.message || failure.error || latestProcessing.error, 300),
    retryable: failure.retryable === true || latestProcessing.retryable === true,
  };
}

function promotionRecordWithBlock(note, record, payload) {
  const snapshot = captureBlockSnapshot(payload);
  if (snapshot.audio_note_id !== requireNoteId(note)) {
    throw new Error("Capture block does not belong to the selected audio note.");
  }
  const old = record?.snapshot || {};
  const sameTranscriptRevision = old.transcript_result_id
    && old.transcript_result_id === snapshot.transcript_result_id
    && old.transcript_provider_id === snapshot.transcript_provider_id
    && old.transcript_provider_request_id === snapshot.transcript_provider_request_id;
  return {
    ...record,
    capture_block_id: snapshot.capture_block_id,
    snapshot,
    handoff: sameTranscriptRevision ? record.handoff || null : null,
  };
}

function canHandoffPromotion(record) {
  const snapshot = record?.snapshot;
  return Boolean(record?.capture_block_id
    && snapshot?.processing_state === "transcribed"
    && snapshot?.transcript_state === "transcribed"
    && snapshot?.transcript_result_id
    && snapshot?.transcript_provider_id);
}

function captureBlockHandoffRequest(record) {
  if (!canHandoffPromotion(record)) throw new Error("This capture block is not ready for handoff.");
  return { confirmed: true, authority: "execute" };
}

function handoffReceiptSnapshot(record, payload) {
  if (!canHandoffPromotion(record)) throw new Error("This capture block is not ready for handoff.");
  const receipt = payload?.handoff || payload;
  const sourceRecordId = cleanText(receipt?.source_record_id, 160);
  const sourceRevision = cleanText(receipt?.source_revision, 200);
  const requestDigest = cleanText(receipt?.request_digest, 200);
  const switchboard = receipt?.switchboard && typeof receipt.switchboard === "object" ? receipt.switchboard : {};
  const admissionId = cleanText(switchboard.admission_id, 160);
  if (receipt?.source_system !== "chief-moa"
      || sourceRecordId !== record.capture_block_id
      || !/^capture-block-v2:[a-f0-9]{64}$/.test(sourceRevision)
      || !/^sha256:[a-f0-9]{64}$/.test(requestDigest)
      || !admissionId) {
    throw new Error("Gateway returned a mismatched Switchboard receipt.");
  }
  return {
    schema_version: 1,
    source_record_id: sourceRecordId,
    source_revision: sourceRevision,
    request_digest: requestDigest,
    admission_id: admissionId,
    raw_intent_id: cleanText(switchboard.raw_intent_id, 160),
    compiled_intent_ids: Array.isArray(switchboard.compiled_intent_ids)
      ? switchboard.compiled_intent_ids.map((id) => cleanText(id, 160)).filter(Boolean).slice(0, 20)
      : [],
    state: cleanText(switchboard.state || "accepted", 80),
  };
}

function promotionRecordWithHandoff(record, payload) {
  return { ...record, handoff: handoffReceiptSnapshot(record, payload) };
}

function handoffPresentation(record) {
  if (!canHandoffPromotion(record)) return null;
  const receipt = record.handoff;
  if (!receipt) return { sent: false, label: "Ready for explicit Switchboard handoff", action: "Send to Switchboard" };
  const intentIds = Array.isArray(receipt.compiled_intent_ids) ? receipt.compiled_intent_ids : [];
  const identities = intentIds.length
    ? `intent ${intentIds.join(", ")}`
    : receipt.raw_intent_id ? `raw intent ${receipt.raw_intent_id}` : `admission ${receipt.admission_id}`;
  return {
    sent: true,
    label: `Sent to Switchboard · ${identities} · ${receipt.state}`,
    action: "Check Switchboard receipt",
  };
}

function promotionPresentation(record) {
  const snapshot = record?.snapshot;
  if (!snapshot) return { state: "stored", label: "Stored raw audio · transcription not requested", action: "Prepare transcript", error: false };
  const state = snapshot.processing_state;
  if (state === "transcribed" && snapshot.transcript_state === "transcribed") {
    return { state: "transcribed", label: "Transcribed · no execution started", action: "Refresh transcript", error: false };
  }
  if (state === "failed" || state === "error") {
    const retry = snapshot.retryable ? " · retry available" : "";
    return {
      state: "failed",
      label: `Transcription failed${snapshot.failure_message ? ` · ${snapshot.failure_message}` : ""}${retry}`,
      action: snapshot.retryable ? "Retry transcript" : "Refresh state",
      error: true,
    };
  }
  if (["processing", "transcribing", "in_progress"].includes(state)) {
    return { state: "transcribing", label: "Transcribing · no execution started", action: "Refresh state", error: false };
  }
  return { state: "queued", label: "Queued for transcription · no execution started", action: "Refresh state", error: false };
}

export {
  CAPTURE_BLOCKS_PATH,
  canHandoffPromotion,
  captureBlockHandoffPath,
  captureBlockHandoffRequest,
  captureBlockPath,
  captureBlockRetryPath,
  captureBlockRequest,
  captureBlockSnapshot,
  newPromotionRecord,
  handoffPresentation,
  promotionPresentation,
  promotionRecordWithBlock,
  promotionRecordWithHandoff,
  promotionStorageKey,
  usablePromotionRecord,
};
