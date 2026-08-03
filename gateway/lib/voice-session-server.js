"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { WebSocket, WebSocketServer } = require("ws");
const {
  CLIENT_AUDIO_FORMAT,
  TurnSupersededError,
  isTurnSupersededError,
  createVoiceProvider,
  generatePcm16Tone: generateProviderTone,
} = require("./voice-providers");
const { mergeTranscriptSidecar } = require("./voice-provider-composition");
const { selectFinalTranscript } = require("./transcript-quality");
const { canonicalVoice } = require("./profile-options");
const {
  hasPartialEndpointPlayback, normalizeAssistantAudioSegment: normalizeSegmentRaw,
  normalizePlaybackProgress: normalizeProgressRaw, normalizeProgressStage,
} = require("./voice-playback-progress");
const { createVoiceSessionAdmission } = require("./voice-session-admission");
const { voiceProviderEnvForProfile } = require("./voice-provider-catalog");
const { createVoiceTurnSteeringCoordinator, planVoiceTurnRelation } = require("./voice-turn-steering");
const { startVoiceSessionHeartbeat, summarizeVoiceActivity } = require("./voice-session-heartbeat");
const { sanitizeTtsDelivery, summarizeTtsTerminal } = require("./voice-tts-terminal");
const { handleTtsRetry, retainTtsRecoveryTurn, releaseTtsRecoveryTurn } = require("./voice-tts-retry");
const { createVoicePhraseAssistSessionBridge } = require("./voice-phrase-assist");
const { VoiceDraftSessionBridge, createVoiceDraftSessionRuntime, disabledVoiceDraftSessionRuntime }
  = require("./voice-draft-session");
const { startVoicePrewarm } = require("./voice-prewarm");
const { isIncognitoBranch } = require("./thread-store");
const { createVoiceTranscriptReconcileBridge, publishTranscriptRevision }
  = require("./voice-transcript-reconcile-session");
const { bindBrowserVoiceInvocationContext } = require("./browser-invocation-context");
const { completeNoSpeech, completeTranscriptFinalization, handleTranscriptFinalize }
  = require("./voice-transcript-finalize");
const VOICE_SESSION_ENDPOINT = "/v1/voice/sessions";
const ASSISTANT_AUDIO_FORMAT = CLIENT_AUDIO_FORMAT;
const EARLY_AUDIO_MAX_BYTES = 16000 * 2 * 5;
const EARLY_AUDIO_MAX_AGE_MS = 3000;
const TERMINAL_TURN_STATUSES = new Set(["completed", "canceled", "error", "closed", "interrupted", "replaced", "no_speech"]);
const ACTIVE_PLAYBACK_PROGRESS_STATUSES = new Set(["committed", "playback"]);
const DEFAULT_TURN_PROGRESS_INTERVAL_MS = 5000;
const PROVIDER_EVENT_ERROR_MAX_CHARS = 240, PROVIDER_EVENT_VALUE_MAX_CHARS = 400;
function createVoiceSessionServer(options) {
  const dataDir = path.resolve(options?.dataDir || "./data");
  const sessionsDir = path.join(dataDir, "voice-sessions");
  const providerEventsFile = path.join(dataDir, "voice-provider-events.jsonl");
  const connections = new Set();
  const heartbeat = startVoiceSessionHeartbeat({ connections, intervalMs: options?.heartbeatIntervalMs });
  const pendingReplacements = new Map();
  const steeringCoordinator = createVoiceTurnSteeringCoordinator({ connections, pending: pendingReplacements });
  const agentProfile = options?.agentProfile || null;
  const voiceDraftRuntime = createVoiceDraftSessionRuntime({ dataDir, store: options?.voiceDraftStore });
  const contextProvider = typeof options?.contextProvider === "function" ? options.contextProvider : null;
  const toolHandler = typeof options?.toolHandler === "function" ? options.toolHandler : null;
  const sessionAdmission = createVoiceSessionAdmission({
    ...options,
    sanitizeId,
    defaultVoiceProviderFactory: (profile) => createVoiceProvider({
      env: voiceProviderEnvForProfile(profile, options?.env || process.env),
      systemPrompt: options?.systemPrompt,
      agentProfile: options?.agentProfile,
      reasoner: typeof options?.reasoner === "function" ? options.reasoner : null,
    }),
  });
  fs.mkdirSync(sessionsDir, { recursive: true });
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: Number(options?.maxPayloadBytes || 2 * 1024 * 1024),
  });
  wss.on("connection", (ws, request) => {
    heartbeat.track(ws);
    const connection = new VoiceSessionConnection(ws, {
      request,
      sessionsDir,
      providerEventsFile,
      sessionAdmission,
      agentProfile,
      contextProvider,
      toolHandler,
      steeringCoordinator,
      turnProgressIntervalMs: options?.turnProgressIntervalMs,
      phraseAssistGenerator: options?.phraseAssistGenerator, phraseAssistOptions: options?.phraseAssistOptions,
      onTurnCompleted: typeof options?.onTurnCompleted === "function" ? options.onTurnCompleted : null,
      blobStore: options?.blobStore || null,
      voiceDraftRuntime,
      transcriptReconcileRuntime: options?.transcriptReconcileRuntime || null,
      env: options?.env || process.env, voiceLatencyNow: options?.voiceLatencyNow,
    });
    connections.add(connection);
    ws.once("close", () => {
      connections.delete(connection);
    });
    connection.start();
  });
  return {
    endpoint: VOICE_SESSION_ENDPOINT,
    sessionsDir,
    providerEventsFile,
    status() {
      return { ...sessionAdmission.status(), voice_drafts_v1: voiceDraftRuntime.status(), transcript_reconciliation: options?.transcriptReconcileRuntime?.status?.() || { active: 0, queued: 0 } };
    },
    activityStatus() {
      return summarizeVoiceActivity(connections);
    },
    publishTranscriptRevision(payload) {
      publishTranscriptRevision(connections, payload);
    },
    handleUpgrade(request, socket, head) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    },
    close(callback) {
      heartbeat.close();
      wss.close(callback);
    },
  };
}
class VoiceSessionConnection {
  constructor(ws, options) {
    this.ws = ws;
    this.request = options.request;
    this.sessionsDir = options.sessionsDir;
    this.providerEventsFile = options.providerEventsFile;
    this.sessionAdmission = options.sessionAdmission || createVoiceSessionAdmission({
      voiceProvider: options.voiceProvider, agentProfile: options.agentProfile, sanitizeId,
    });
    this.voiceProvider = null;
    this.contextProvider = options.contextProvider || null;
    this.toolHandler = options.toolHandler || null;
    this.onTurnCompleted = options.onTurnCompleted || null;
    this.blobStore = options.blobStore || null;
    this.steeringCoordinator = options.steeringCoordinator || createVoiceTurnSteeringCoordinator(
      { connections: options.peerConnections || new Set(), pending: options.pendingReplacements || new Map() });
    this.turn = null;
    this.responding = false;
    this.earlyAudio = [];
    this.earlyAudioBytes = 0;
    this.turnProgressTimer = null;
    this.turnProgressStage = "";
    this.ttsRetryReceipts = new Map();
    this.turnProgressIntervalMs = normalizeTurnProgressIntervalMs(options.turnProgressIntervalMs);
    this.phraseAssist = createVoicePhraseAssistSessionBridge(this, options, sanitizeId);
    this.voiceDraft = new VoiceDraftSessionBridge(
      this, options.voiceDraftRuntime || disabledVoiceDraftSessionRuntime(),
    );
    this.transcriptReconcile = createVoiceTranscriptReconcileBridge(this, options.transcriptReconcileRuntime, WebSocket.OPEN, { env: options.env, now: options.voiceLatencyNow });
    this.sessionIdentity = null;
  }
  startTurnProgress(turn, stage) {
    const nextStage = normalizeProgressStage(stage);
    if (nextStage) {
      this.turnProgressStage = nextStage;
    } else if (!this.turnProgressStage) {
      this.turnProgressStage = "reasoning";
    }
    if (this.turnProgressTimer || !turn) {
      return;
    }
    const intervalMs = this.turnProgressIntervalMs;
    if (!(intervalMs > 0)) {
      return;
    }
    this.turnProgressTimer = setInterval(() => {
      if (this.ws.readyState !== WebSocket.OPEN
          || this.turn !== turn
          || TERMINAL_TURN_STATUSES.has(turn.status)) {
        this.stopTurnProgress();
        return;
      }
      if (turn.streamingAudio && turn.lastAssistantAudioAt) {
        const lastAudioMs = Date.parse(turn.lastAssistantAudioAt);
        if (Number.isFinite(lastAudioMs) && Date.now() - lastAudioMs < intervalMs) {
          return;
        }
      }
      try {
        this.ws.send(JSON.stringify({
          type: "turn_progress",
          session_id: turn.sessionId,
          branch_id: turn.branchId,
          turn_id: turn.turnId,
          stage: this.turnProgressStage || "reasoning",
        }));
      } catch {
        this.stopTurnProgress();
      }
    }, intervalMs);
    this.turnProgressTimer.unref?.();
  }
  stopTurnProgress() {
    if (this.turnProgressTimer) {
      clearInterval(this.turnProgressTimer);
      this.turnProgressTimer = null;
    }
    this.turnProgressStage = "";
  }
  start() {
    this.ws.on("message", (data, isBinary) => {
      if (isBinary) {
        this.handleAudio(data);
        return;
      }
      void this.handleText(data).catch((error) => {
        this.sendError(cleanError(error));
      });
    });
    this.ws.on("close", () => {
      void this.voiceDraft.parkOnClose();
      void this.closeCurrentTurn("closed");
    });
    this.ws.on("error", () => {
      void this.voiceDraft.parkOnClose();
      void this.closeCurrentTurn("error");
    });
  }
  async handleText(data) {
    let event;
    try {
      event = JSON.parse(Buffer.from(data).toString("utf8"));
    } catch (error) {
      this.sendError("text messages must be valid JSON");
      return;
    }
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      this.sendError("text messages must be JSON objects");
      return;
    }
    const type = String(event.type || "");
    if (type === "session_start") {
      await this.handleSessionStart(event);
      return;
    }
    if (type === "commit_turn") {
      await this.handleCommitTurn(event);
      return;
    }
    if (type === "voice_draft_control") {
      await this.voiceDraft.control(event);
      return;
    }
    if (type === "finalize_transcript") {
      await handleTranscriptFinalize(this, event, {
        captureSummaryForTurn, closeAudioStream, transportSummaryForTurn,
      });
      return;
    }
    if (type === "text_turn") {
      await this.handleTextTurn(event);
      return;
    }
    if (type === "cancel_turn") {
      await this.handleCancelTurn(event);
      return;
    }
    if (await this.phraseAssist.handleEvent(type, event)) return;
    if (type === "playback_progress") {
      await this.handlePlaybackProgress(event);
      return;
    }
    if (type === "retry_tts") {
      await handleTtsRetry(this, event, {
        sanitizeId, randomId, sendWs, turnReplyLanguage, cleanErrorSummary,
        assistantAudioFormat: ASSISTANT_AUDIO_FORMAT, webSocketOpen: WebSocket.OPEN,
      });
      return;
    }
    this.sendError(`unsupported voice event type: ${type || "missing"}`);
  }
  handleAudio(data) {
    const chunk = toBuffer(data);
    if (chunk.length === 0) {
      return;
    }
    if (chunk.length % 2 !== 0) {
      this.sendError("pcm16 audio frames must contain an even number of bytes");
      return;
    }
    if (this.voiceDraft.append(chunk)) return;
    if (!this.turn) {
      this.bufferEarlyAudio(chunk);
      return;
    }
    if (this.turn.status !== "recording") {
      return;
    }
    this.writeTurnAudio(this.turn, chunk);
  }
  writeTurnAudio(turn, chunk) {
    if (!turn.audioStream) {
      return;
    }
    turn.audioBytes += chunk.length;
    turn.audioChunks += 1;
    turn.lastAudioAt = nowIso();
    turn.audioStream.write(chunk);
    this.transcriptReconcile.push(turn, chunk);
    if (turn.liveSession) {
      turn.liveSession.sendAudio(chunk);
    }
    if (turn.sttStream) {
      turn.sttStream.push(chunk);
    }
  }
  bufferEarlyAudio(chunk) {
    this.earlyAudio.push({ at: Date.now(), chunk });
    this.earlyAudioBytes += chunk.length;
    while (this.earlyAudioBytes > EARLY_AUDIO_MAX_BYTES && this.earlyAudio.length > 0) {
      const dropped = this.earlyAudio.shift();
      this.earlyAudioBytes -= dropped.chunk.length;
    }
  }
  flushEarlyAudio(turn) {
    const buffered = this.earlyAudio;
    this.earlyAudio = [];
    this.earlyAudioBytes = 0;
    const oldestAllowed = Date.now() - EARLY_AUDIO_MAX_AGE_MS;
    for (const entry of buffered) {
      if (entry.at < oldestAllowed) continue;
      if (turn.status !== "recording") return;
      this.writeTurnAudio(turn, entry.chunk);
    }
  }
  async handleSessionStart(event) {
    const sessionId = sanitizeId(event.session_id || randomId("session"), "session_id");
    const conversationId = sanitizeId(event.conversation_id || sessionId, "conversation_id");
    const branchId = sanitizeId(event.branch_id || "default", "branch_id");
    const turnId = sanitizeId(event.turn_id || randomId("turn"), "turn_id");
    const nextTurnIdentity = { sessionId, conversationId, branchId, turnId,
      deviceId: sanitizeLooseId(event.device_id || event.deviceId || event.client?.device_id || event.client?.deviceId || ""),
      contextAction: event.context_action || event.contextAction };
    if (await this.voiceDraft.start(event, nextTurnIdentity)) {
      this.earlyAudio = [];
      this.earlyAudioBytes = 0;
      return;
    }
    const pendingReplacement = this.steeringCoordinator.take(nextTurnIdentity);
    const priorConnection = pendingReplacement ? null : this.steeringCoordinator.findActive(this, nextTurnIdentity);
    const priorTurn = priorConnection?.turn || null;
    const turnRelation = pendingReplacement ? { next: pendingReplacement.next }
      : planVoiceTurnRelation(priorTurn, nextTurnIdentity, { boundaryId: randomId("steer"), occurredAt: nowIso() });
    if (turnRelation && priorConnection) {
      priorTurn.turnRelation = turnRelation.prior;
      await priorConnection.closeCurrentTurn(turnRelation.closeStatus);
      priorConnection.responding = false;
    }
    const turnDir = path.join(this.sessionsDir, sessionId);
    const format = normalizeFormat(event.format);
    const playbackPolicy = normalizePlaybackPolicy(event.playback_policy || event.playbackPolicy);
    const allBranchesContext = event.all_branches_context === true || event.allBranchesContext === true;
    const deviceId = nextTurnIdentity.deviceId;
    const profileVersion = this.sessionAdmission.profileVersion(deviceId),
      effectiveProfile = effectiveProfileForSession(this.sessionAdmission.effectiveProfile(deviceId), event);
    const admitted = await this.sessionAdmission.admit({ deviceId, sessionId, branchId, turnId,
      sendEvent: (payload) => this.sendEvent(payload), onDenied: () => { this.earlyAudio = []; this.earlyAudioBytes = 0; },
      effectiveProfile, profileVersion });
    if (!admitted.provider) {
      return;
    }
    const startedAt = nowIso();
    const pinnedProfileVersion = admitted.profileVersion || profileVersion,
      pinnedEffectiveProfile = admitted.effectiveProfile || this.sessionAdmission.applyProfile(effectiveProfile, admitted.admission);
    const persona = personaForSession(event);
    this.voiceProvider = admitted.provider;
    const providerStatus = this.voiceProvider.status();
    fs.mkdirSync(turnDir, { recursive: true });
    const turn = {
      sessionId,
      conversationId,
      branchId,
      turnId,
      profileVersion: pinnedProfileVersion,
      effectiveProfile: pinnedEffectiveProfile,
      persona,
      providerStatus, providerBundle: admitted.providerBundle || "",
      deviceId,
      source: String(event.source || "android-overlay").slice(0, 120),
      format, playbackPolicy,
      transcriptionOnly: event.transcription_only === true || event.transcriptionOnly === true,
      allBranchesContext,
      turnDir,
      pcmPath: path.join(turnDir, `${turnId}.pcm`),
      assistantPcmPath: path.join(turnDir, `${turnId}.assistant.pcm`),
      metadataPath: path.join(turnDir, `${turnId}.json`),
      // Blob-store handles for write-behind upload once each stream closes.
      // The .pcm files above stay the live spool: STT reads them mid-turn.
      blobStore: this.blobStore,
      userAudioKey: `voice-sessions/${sessionId}/${turnId}.pcm`,
      assistantAudioKey: `voice-sessions/${sessionId}/${turnId}.assistant.pcm`,
      startedAt,
      lastAudioAt: null,
      lastAssistantAudioAt: null,
      status: "recording",
      audioBytes: 0,
      audioChunks: 0,
      assistantAudioBytes: 0,
      assistantAudioChunks: 0,
      firstAssistantAudioMs: null,
      assistantAudioSegments: [],
      playbackProgress: null,
      metadata: {},
      audioStream: null,
      assistantAudioStream: null,
      assistantAudioClosed: false,
      streamingAudio: false,
      providerEvents: null,
      liveSession: null,
      sttStream: null,
      completing: false,
      recordedCanonical: false,
      contextPrompt: "",
      contextBuildFailed: false,
      contextSummary: {},
      captureSummary: {},
      transportSummary: {},
      syntheticText: "",
      turnRelation: turnRelation?.next || null,
      transcriptSequence: 0,
    };
    this.phraseAssist.configureTurn(turn, event.phrase_assist || event.phraseAssist);
    turn.contextPrompt = this.contextPromptForTurn(turn);
    turn.contextSummary = contextSummaryForTurn(turn, this.contextProvider);
    turn.audioStream = fs.createWriteStream(turn.pcmPath, { flags: "w" });
    turn.audioStream.on("error", (error) => {
      turn.status = "error";
      writeTurnMetadata(turn, { status: "error", error: cleanError(error) });
      this.sendError(`failed to write audio: ${cleanError(error)}`);
    });
    this.turn = turn;
    this.sessionIdentity = { ownerId: deviceId || "legacy_owner", sessionId, branchId, turnId };
    const reconcileRequest = event.transcript_reconciliation || event.transcriptReconciliation || {};
    this.transcriptReconcile.configure(turn, { provider: this.voiceProvider, ownerId: deviceId || "legacy_owner", format,
      languageCodes: providerStatus.prompt_language_codes || providerStatus.language_codes || ["en-US"],
      enabled: reconcileRequest.enabled === true && Number(reconcileRequest.version) === 1 && reconcileRequest.privacy_scope === "retained" && nextTurnIdentity.contextAction === "continue",
      incognito: isIncognitoBranch(branchId) || nextTurnIdentity.contextAction === "incognito" });
    startVoicePrewarm(this.voiceProvider, turn);
    if (typeof this.voiceProvider.createLiveTurnSession === "function") {
      turn.providerEvents = this.createProviderEvents(turn);
      try {
        turn.liveSession = this.voiceProvider.createLiveTurnSession(turn, this.providerHooks(turn, turn.providerEvents));
      } catch (error) {
        turn.status = "error";
        await closeAudioStream(turn);
        await this.recordProviderEvent(turn, turn.providerEvents, "turn_error", {
          error: cleanError(error),
        });
        writeTurnMetadata(turn, { status: "error", error: cleanError(error) });
        this.sendError(`failed to start voice turn: ${cleanError(error)}`);
        await this.sendEvent({
          type: "turn_done",
          session_id: sessionId,
          branch_id: branchId,
          turn_id: turnId,
          status: "error",
        });
        if (this.turn === turn) {
          this.turn = null;
        }
        return;
      }
      turn.liveSession.done
        .then((providerResult) => this.completeLiveTurn(turn, providerResult))
        .catch((error) => this.failLiveTurn(turn, error));
    }
    if (typeof this.voiceProvider.createStreamingSttSession === "function") {
      turn.providerEvents = turn.providerEvents || this.createProviderEvents(turn);
      try {
        turn.sttStream = this.voiceProvider.createStreamingSttSession(
          turn,
          this.providerHooks(turn, turn.providerEvents),
        );
        if (turn.liveSession && turn.sttStream) {
          turn.sttStreamRole = "transcript_sidecar";
        }
      } catch (error) {
        turn.sttStream = null;
        writeTurnMetadata(turn, { stt_stream_error: cleanError(error) });
      }
    }
    this.flushEarlyAudio(turn);
    writeTurnMetadata(turn, { status: "recording" });
    await this.sendEvent({
      type: "session_ready",
      session_id: sessionId,
      branch_id: branchId,
      turn_id: turnId,
      playback_policy: playbackPolicy,
      phrase_assist: this.phraseAssist.capability(turn),
      transcript_finalize: {
        supported: !turn.liveSession && typeof this.voiceProvider?.transcribeTurn === "function",
      },
      capabilities: {
        voice_drafts_v1: this.voiceDraft.runtime.capability,
        transcript_revisions_v1: this.transcriptReconcile.capability(turn),
      },
      provider_bundle: turn.providerBundle,
      ...(turn.turnRelation ? { turn_relation: turn.turnRelation } : {}),
    });
    turn.providerEvents = turn.providerEvents || this.createProviderEvents(turn);
    await this.recordProviderEvent(turn, turn.providerEvents, "profile_applied", {
      application: "turn_start",
    });
    await this.recordProviderEvent(turn, turn.providerEvents, "context_attached", turn.contextSummary);
    await this.sendEvent({
      type: "profile_applied",
      session_id: sessionId,
      branch_id: branchId,
      turn_id: turnId,
      profile_version: pinnedProfileVersion,
      device_id: deviceId,
    });
  }
  contextPromptForTurn(turn) {
    if (!this.contextProvider) {
      return "";
    }
    try {
      return String(this.contextProvider({
        session_id: turn.sessionId,
        conversation_id: turn.conversationId || turn.sessionId,
        branch_id: turn.branchId || "default",
        all_branches_context: turn.allBranchesContext === true,
        turn_id: turn.turnId,
        profile_version: turn.profileVersion || "",
        device_id: turn.deviceId || "",
      }) || "").slice(0, 12000);
    } catch {
      turn.contextBuildFailed = true;
      return "";
    }
  }
  async handleCommitTurn(event, preparedDraft = false) {
    if (this.voiceDraft.active && !preparedDraft) {
      await this.handleVoiceDraftSend(event);
      return;
    }
    if (this.responding) {
      this.sendError("turn is already being committed");
      return;
    }
    const turn = this.currentTurnFor(event.turn_id);
    if (!turn) {
      return;
    }
    if (turn.status !== "recording") {
      this.sendError(`turn is not recordable: ${turn.status}`);
      return;
    }
    if (bindBrowserVoiceInvocationContext(turn, event)) turn.contextSummary = contextSummaryForTurn(turn, this.contextProvider);
    this.responding = true;
    const providerEvents = turn.providerEvents || this.createProviderEvents(turn);
    turn.providerEvents = providerEvents;
    const providerHooks = this.providerHooks(turn, providerEvents);
    try {
      this.transcriptReconcile.commit(turn);
      await this.phraseAssist.stop(turn);
      turn.status = "committed";
      turn.captureSummary = captureSummaryForTurn(turn, { inputKind: "audio" });
      turn.transportSummary = transportSummaryForTurn(turn, "audio");
      await this.recordProviderEvent(turn, providerEvents, "capture_committed", turn.captureSummary);
      await this.recordProviderEvent(turn, providerEvents, "transport_committed", turn.transportSummary);
      if (turn.liveSession) {
        // Live/native path: the provider streams through the session-start hooks
        // and never calls onTurnProgress, so the session server keepalives from
        // commit until the first assistant-audio event (which stops it) or a
        // terminal path. Cascaded turns start progress via the onTurnProgress
        // hook when the reasoner begins.
        this.startTurnProgress(turn, "reasoning");
      }
      await closeAudioStream(turn);
      this.transcriptReconcile.finish(turn);
      const providerResult = turn.liveSession
        ? await commitLiveSession(turn)
        : await this.voiceProvider.processTurn(turn, providerHooks);
      if (this.turn !== turn || turn.completing) {
        return;
      }
      turn.completing = true;
      await this.completeTurnWithProviderResult(turn, providerEvents, providerResult);
    } catch (error) {
      await this.failCommittedTurn(turn, providerEvents, error);
    } finally {
      this.responding = false;
    }
  }
  async handleVoiceDraftSend(event) {
    if (this.responding) {
      this.sendError("turn is already being committed");
      return;
    }
    const commit = await this.voiceDraft.prepareSend(event);
    await this.handleSessionStart(commit.startEvent);
    const turn = this.currentTurnFor(commit.identity.turnId);
    if (!turn) return;
    turn.voiceDraftCommit = commit;
    this.writeTurnAudio(turn, commit.audio);
    await this.handleCommitTurn({ ...event, turn_id: commit.identity.turnId }, true);
  }
  async handleTextTurn(event) {
    if (this.responding) {
      this.sendError("turn is already being committed");
      return;
    }
    const turn = this.currentTurnFor(event.turn_id);
    if (!turn) {
      return;
    }
    if (turn.status !== "recording") {
      this.sendError(`turn is not recordable: ${turn.status}`);
      return;
    }
    const text = String(event.text || event.prompt || "").trim().replace(/\s+/g, " ").slice(0, 1000);
    if (!text) {
      this.sendError("text_turn requires text");
      return;
    }
    // Live/native providers need a session-level sendText. Cascaded and
    // loopback providers have no liveSession at all: their processTurn path
    // reads turn.syntheticText and skips the STT leg, same shape as
    // handleCommitTurn's non-live branch.
    if (turn.liveSession && typeof turn.liveSession.sendText !== "function") {
      this.sendError("voice provider does not support text_turn");
      return;
    }
    this.responding = true;
    const providerEvents = turn.providerEvents || this.createProviderEvents(turn);
    turn.providerEvents = providerEvents;
    const providerHooks = this.providerHooks(turn, providerEvents);
    try {
      await this.phraseAssist.stop(turn);
      turn.status = "committed";
      turn.syntheticText = text;
      turn.captureSummary = captureSummaryForTurn(turn, { inputKind: "text", textChars: text.length });
      turn.transportSummary = transportSummaryForTurn(turn, "text");
      await this.recordProviderEvent(turn, providerEvents, "capture_committed", turn.captureSummary);
      await this.recordProviderEvent(turn, providerEvents, "transport_committed", turn.transportSummary);
      if (turn.liveSession) {
        this.startTurnProgress(turn, "reasoning");
      }
      await closeAudioStream(turn);
      const providerResult = turn.liveSession
        ? await commitLiveTextSession(turn, text)
        : await this.voiceProvider.processTurn(turn, providerHooks);
      if (this.turn !== turn || turn.completing) {
        return;
      }
      turn.completing = true;
      await this.completeTurnWithProviderResult(turn, providerEvents, providerResult);
    } catch (error) {
      await this.failCommittedTurn(turn, providerEvents, error);
    } finally {
      this.responding = false;
    }
  }
  createProviderEvents(turn) {
    return {
      transcript: "",
      assistantText: "",
      transcriptFinalSent: false,
      assistantTextSent: false,
      assistantAudioStarted: false,
      assistantAudioDone: false,
      activeStage: "",
      stageFailed: false,
      stageStartedAt: {},
      stageTimings: {},
      events: Array.isArray(turn?.providerEvents?.events) ? turn.providerEvents.events : [],
    };
  }
  providerHooks(turn, providerEvents) {
    const assertTurnActive = () => {
      if (this.turn !== turn || TERMINAL_TURN_STATUSES.has(turn.status)) {
        throw new TurnSupersededError(`turn ${turn.turnId} was superseded`);
      }
    };
    const turnSuperseded = () => this.turn !== turn || TERMINAL_TURN_STATUSES.has(turn.status);
    // Shared emitter for the turn's text events. Deltas keep leading/trailing
    // whitespace (it is content mid-sentence); whole-value events are trimmed.
    const TEXT_EVENT_FIELDS = {
      transcript_partial: { key: "text", stamp: (v) => { providerEvents.transcript = v; } },
      transcript_final: { key: "text", stamp: (v) => { providerEvents.transcript = v; providerEvents.transcriptFinalSent = true; } },
      assistant_text: { key: "text", stamp: (v) => { providerEvents.assistantText = v; providerEvents.assistantTextSent = true; } },
      assistant_text_delta: { key: "delta", stamp: () => { providerEvents.assistantTextDeltaCount = (providerEvents.assistantTextDeltaCount || 0) + 1; } },
    };
    const sendTurnText = async (type, text, { revisions = false, record = true } = {}) => {
      if (turnSuperseded()) return;
      const spec = TEXT_EVENT_FIELDS[type];
      const value = record ? String(text || "").trim() : String(text ?? "");
      if (!value) return;
      spec.stamp(value);
      const transcriptSequence = type.startsWith("transcript_")
        ? this.transcriptReconcile.sequence(turn) : null;
      if (record) await this.recordProviderEvent(turn, providerEvents, type, { text: value });
      await this.sendEvent({
        type,
        session_id: turn.sessionId,
        branch_id: turn.branchId,
        turn_id: turn.turnId,
        [spec.key]: value,
        ...(transcriptSequence ? { transcript_sequence: transcriptSequence } : {}),
        ...(revisions ? await this.phraseAssist.revisionField(turn, value) : {}),
      });
    };
    return {
      isTurnActive: () => !turnSuperseded(),
      onTurnProgress: async (stage) => {
        this.startTurnProgress(turn, stage);
      },
      onTranscriptFinalSegment: async (segment) => {
        if (turnSuperseded()) return;
        this.transcriptReconcile.seal(turn, segment);
      },
      onStageStart: async (stage, details) => {
        if (turnSuperseded()) return;
        const stageName = normalizeStageName(stage);
        providerEvents.activeStage = stageName;
        providerEvents.stageStartedAt[stageName] = Date.now();
        await this.recordProviderEvent(turn, providerEvents, "stage_start", {
          stage: stageName,
          ...sanitizeStageDetails(details),
        });
      },
      onStageDone: async (stage, details) => {
        if (turnSuperseded()) return;
        const stageName = normalizeStageName(stage);
        const sanitized = sanitizeStageDetails(details);
        const durationMs = normalizeDurationMs(
          sanitized.duration_ms,
          providerEvents.stageStartedAt[stageName],
        );
        delete sanitized.duration_ms;
        providerEvents.stageTimings[`${stageName}_ms`] = durationMs;
        if (providerEvents.activeStage === stageName) {
          providerEvents.activeStage = "";
        }
        await this.recordProviderEvent(turn, providerEvents, "stage_done", {
          stage: stageName,
          duration_ms: durationMs,
          ...sanitized,
        });
      },
      onStageError: async (stage, details) => {
        if (turnSuperseded()) return;
        const stageName = normalizeStageName(stage);
        const sanitized = sanitizeStageDetails(details);
        const durationMs = normalizeDurationMs(
          sanitized.duration_ms,
          providerEvents.stageStartedAt[stageName],
        );
        delete sanitized.duration_ms;
        const errorSummary = cleanErrorSummary(sanitized.error_summary || sanitized.error || "stage failed");
        delete sanitized.error;
        delete sanitized.error_summary;
        providerEvents.stageFailed = true;
        providerEvents.stageTimings[`${stageName}_ms`] = durationMs;
        if (providerEvents.activeStage === stageName) {
          providerEvents.activeStage = "";
        }
        await this.recordProviderEvent(turn, providerEvents, "stage_error", {
          stage: stageName,
          duration_ms: durationMs,
          error_summary: errorSummary,
          ...sanitized,
        });
      },
      // The four text hooks differ only in which providerEvents field they
      // stamp and whether they carry phrase-assist revisions, so they share one
      // emitter. `record: false` keeps per-token deltas out of the turn's event
      // log while still broadcasting them.
      onTranscriptPartial: (text) => sendTurnText("transcript_partial", text, { revisions: true }),
      onTranscriptFinal: (text) => sendTurnText("transcript_final", text, { revisions: true }),
      onAssistantText: (text) => sendTurnText("assistant_text", text),
      // Incremental reply text: the same sanitized deltas that feed the chunked
      // TTS leg, forwarded so the ribbon fills in as the model writes.
      // `assistant_text` stays the one stored, authoritative reply, so a client
      // that ignores deltas still renders a correct turn.
      onAssistantTextDelta: (delta) => sendTurnText("assistant_text_delta", delta, { record: false }),
      onAssistantAudioSegment: async (segment) => {
        assertTurnActive();
        const normalized = normalizeAssistantAudioSegment(segment, turn.assistantAudioSegments);
        if (!normalized) {
          return;
        }
        turn.assistantAudioSegments.push(normalized);
        assertTurnActive();
        await this.sendEvent({
          type: "assistant_audio_segment",
          session_id: turn.sessionId,
          branch_id: turn.branchId,
          turn_id: turn.turnId,
          ...normalized,
        });
      },
      onAssistantAudioStart: async (format, options) => {
        assertTurnActive();
        providerEvents.assistantAudioStarted = true;
        const streaming = options?.streaming === true;
        const rawRate = Number(options?.playbackRate);
        const playbackRate = Number.isFinite(rawRate) && rawRate > 0 && rawRate !== 1
          ? Math.min(2, Math.max(0.5, rawRate))
          : 0;
        if (streaming) {
          turn.streamingAudio = true;
        } else {
          this.stopTurnProgress();
        }
        await this.recordProviderEvent(turn, providerEvents, "assistant_audio_start", {
          format: format || ASSISTANT_AUDIO_FORMAT,
          ...(streaming ? { streaming: true } : {}),
          ...(playbackRate ? { playback_rate: playbackRate } : {}),
        });
        assertTurnActive();
        await this.sendEvent({
          type: "assistant_audio_start",
          session_id: turn.sessionId,
          branch_id: turn.branchId,
          turn_id: turn.turnId,
          format: format || ASSISTANT_AUDIO_FORMAT,
          ...(streaming ? { streaming: true } : {}),
          ...(playbackRate ? { playback_rate: playbackRate } : {}),
        });
      },
      sendAudio: async (chunk, meta) => {
        assertTurnActive();
        const wroteAudio = await writeAssistantAudio(turn, chunk);
        assertTurnActive();
        if (wroteAudio && !Number.isFinite(turn.firstAssistantAudioMs)) {
          turn.firstAssistantAudioMs = Math.max(0, elapsedMsSince(turn.startedAt));
          providerEvents.stageTimings.first_audio_ms = turn.firstAssistantAudioMs;
          await this.recordProviderEvent(turn, providerEvents, "stage_done", {
            stage: "first_audio",
            duration_ms: turn.firstAssistantAudioMs,
            audio_bytes: toBuffer(chunk).length,
          });
        }
        assertTurnActive();
        await sendWs(this.ws, chunk, { binary: true });
        const segmentText = typeof meta?.segmentText === "string" ? meta.segmentText : "";
        if (segmentText) {
          if (!Array.isArray(turn.assistantSegments)) {
            turn.assistantSegments = [];
          }
          const bytesPerMs = (ASSISTANT_AUDIO_FORMAT.sample_rate * 2) / 1000;
          turn.assistantSegments.push({
            text: segmentText,
            ms: Math.round(toBuffer(chunk).length / bytesPerMs),
          });
        }
      },
      sendToolResponse: async (functionResponses) => {
        await this.sendEvent({
          type: "tool_response",
          session_id: turn.sessionId,
          branch_id: turn.branchId,
          turn_id: turn.turnId,
          responses: functionResponses,
        });
        if (turn.liveSession && typeof turn.liveSession.sendToolResponse === "function") {
          turn.liveSession.sendToolResponse(functionResponses);
        }
      },
      onToolCall: async (call) => this.handleToolCall(turn, providerEvents, call),
      onAssistantAudioDone: async (details = {}) => {
        assertTurnActive();
        providerEvents.assistantAudioDone = true;
        const delivery = sanitizeTtsDelivery(details.tts_delivery);
        const terminalDetails = {
          ...(typeof details.complete === "boolean" ? { complete: details.complete } : {}),
          ...(delivery ? { tts_delivery: delivery } : {}),
          ...(Number.isFinite(details.tts_segments) ? { tts_segments: Math.max(0, Math.round(details.tts_segments)) } : {}),
          ...(Number.isInteger(details.tts_failed_segment_index) && details.tts_failed_segment_index >= 0
            ? { tts_failed_segment_index: details.tts_failed_segment_index }
            : {}),
          ...(Number.isFinite(details.tts_spoken_text_end)
            ? { tts_spoken_text_end: Math.max(0, Math.round(details.tts_spoken_text_end)) }
            : {}),
          ...(details.tts_error ? { tts_error: cleanErrorSummary(details.tts_error) } : {}),
        };
        await this.recordProviderEvent(turn, providerEvents, "assistant_audio_done", terminalDetails);
        assertTurnActive();
        await this.sendEvent({
          type: "assistant_audio_done",
          session_id: turn.sessionId,
          branch_id: turn.branchId,
          turn_id: turn.turnId,
          ...terminalDetails,
        });
      },
    };
  }
  async handleToolCall(turn, providerEvents, call) {
    const name = String(call?.name || "").trim();
    const args = call?.args && typeof call.args === "object" && !Array.isArray(call.args) ? call.args : {};
    await this.recordProviderEvent(turn, providerEvents, "tool_call", {
      tool_name: name,
      tool_call_id: call?.id || "",
      args,
    });
    if (!this.toolHandler) {
      return { ok: false, error: "no live tool handler is configured" };
    }
    try {
      const result = await this.toolHandler({
        name,
        args,
        transcript: providerEvents.transcript || turn.syntheticText || "",
        session_id: turn.sessionId,
        conversation_id: turn.conversationId || turn.sessionId,
        branch_id: turn.branchId || "default",
        all_branches_context: turn.allBranchesContext === true,
        turn_id: turn.turnId,
        transcript: providerEvents.transcript || turn.syntheticText || "",
        profile_version: turn.profileVersion || "",
        device_id: turn.deviceId || "",
        source: turn.source,
        invocation_context: turn.invocationContext || null,
      });
      await this.recordProviderEvent(turn, providerEvents, "tool_result", {
        tool_name: name,
        tool_call_id: call?.id || "",
        result,
      });
      await this.forwardTurnAction(turn, result);
      return result;
    } catch (error) {
      const result = { ok: false, error: cleanError(error) };
      await this.recordProviderEvent(turn, providerEvents, "tool_result", {
        tool_name: name,
        tool_call_id: call?.id || "",
        result,
      });
      return result;
    }
  }
  // A tool result may carry a client-actionable action (page_tweak or
  // companion_motion). The tool response we send the provider is not visible to
  // the client, and native-audio models go silent after a tool call, so the
  // visual/motion confirmation is the primary feedback. Forward the action as its
  // own control event on the session socket, following the same envelope the HTTP
  // turn path attaches to actions[], so the client can apply it the same way on
  // both paths.
  async forwardTurnAction(turn, result) {
    const action = result && typeof result === "object" ? result.action : null;
    await this.emitClientAction(turn, action, typeof result?.message === "string" ? result.message : "");
  }
  // Emit one client-forwardable action envelope. page_tweak carries a `record`;
  // companion_motion carries a `plan`. Unknown or malformed actions are ignored.
  async emitClientAction(turn, action, message = "") {
    if (!action || typeof action !== "object" || Array.isArray(action)) {
      return;
    }
    if (action.type === "page_tweak" && action.record) {
      await this.sendEvent({
        type: "page_tweak",
        session_id: turn.sessionId,
        branch_id: turn.branchId,
        turn_id: turn.turnId,
        action,
        record: action.record,
        message: typeof message === "string" ? message : "",
      });
      return;
    }
    if (action.type === "companion_motion" && action.plan) {
      await this.sendEvent({
        type: "companion_motion",
        session_id: turn.sessionId,
        branch_id: turn.branchId,
        turn_id: turn.turnId,
        action,
        plan: action.plan,
        message: typeof message === "string" ? message : "",
      });
    }
  }
  async completeLiveTurn(turn, providerResult) {
    if (this.turn !== turn || turn.completing || TERMINAL_TURN_STATUSES.has(turn.status)) {
      return;
    }
    turn.completing = true;
    this.responding = true;
    try {
      await closeAudioStream(turn);
      await closeAssistantAudioStream(turn);
      await this.completeTurnWithProviderResult(turn, turn.providerEvents || this.createProviderEvents(turn), providerResult);
    } catch (error) {
      await this.failLiveTurn(turn, error);
    } finally {
      this.responding = false;
    }
  }
  async completeTurnWithProviderResult(turn, providerEvents, providerResult) {
    providerResult = await mergeTranscriptSidecar({
      turn,
      providerResult,
      provider: turn.providerStatus?.transcript_sidecar?.provider || "transcript_sidecar",
      finalize: () => this.voiceProvider.finalizeStreamingSttSession(turn),
      record: (type, payload) => this.recordProviderEvent(turn, providerEvents, type, payload),
      cleanError: (error) => cleanErrorSummary(cleanError(error)),
    });
    // Merge streaming partials into the final transcript: if the provider result
    // is missing a transcript (or, from an older provider, carries the legacy
    // "Voice captured." placeholder) but a real transcript_partial /
    // transcript_final arrived over the stream, prefer that so the stored turn
    // holds what was actually heard, never a fabricated fallback.
    const selected = selectFinalTranscript(providerResult, providerEvents);
    const { transcript, assistantText, rejected: transcriptQualityRejected } = selected;
    const assistantAudioFormat = providerResult?.audio_format || ASSISTANT_AUDIO_FORMAT;
    const hasAssistantOutput = Boolean(assistantText)
      || providerEvents.assistantAudioStarted
      || turn.assistantAudioBytes > 0;
    if (!transcript && !hasAssistantOutput) {
      await completeNoSpeech(this, turn, providerEvents, providerResult, transcriptQualityRejected, {
        nowIso, turnInputLanguages, turnReplyLanguage, writeTurnMetadata,
      });
      return;
    }
    writeTurnMetadata(turn, {
      status: "committed",
      committed_at: nowIso(),
      transcript: {
        final: true,
        text: transcript,
      },
      assistant: {
        text: assistantText,
        provider: providerResult?.provider || this.voiceProvider.status().provider,
        model: providerResult?.model || this.voiceProvider.status().model,
        audio_format: assistantAudioFormat,
      },
    });
    const providerHooks = this.providerHooks(turn, providerEvents);
    if (transcript && !providerEvents.transcriptFinalSent) {
      await providerHooks.onTranscriptFinal(transcript);
    }
    let transcriptSource = String(providerResult?.transcript_source || "").trim();
    if (!transcriptSource || (transcriptSource === "synthetic" && transcript)) {
      transcriptSource = transcript ? "stt" : "synthetic";
    }
    await closeAssistantAudioStream(turn);
    const canonicalRecord = await this.recordCompletedTurn(turn, providerResult, {
      transcript,
      transcriptSource,
      assistantText,
      assistantAudioFormat,
    });
    if (turn.voiceDraftCommit) {
      if (!canonicalRecord) throw new Error("canonical voice draft acceptance failed");
      await this.voiceDraft.markSent(turn.voiceDraftCommit);
    }
    if (turn.finalizeTranscriptOnly) {
      await completeTranscriptFinalization(
        this, turn, providerEvents, providerResult, canonicalRecord, transcript,
        { elapsedMsSince, nowIso, sanitizeStageTimings, turnInputLanguages, turnReplyLanguage, writeTurnMetadata },
      );
      return;
    }
    const profileControlText = profileControlAssistantText(canonicalRecord);
    // classified non-chat, so the provider returned no spoken reply; the gateway
    // produced the confirmation text while applying the change. Send it as text
    // and, when the provider can synthesize (cascaded pipeline) and the modality
    // is not text-only, also stream hosted reply audio. The profile change was
    // already applied once by the turn recorder — this only adds the voice.
    let confirmationTts = null;
    if (profileControlText) {
      if (String(providerEvents.assistantText || "").trim() !== profileControlText) {
        await providerHooks.onAssistantText(profileControlText);
      }
      if (!providerEvents.assistantAudioStarted
          && typeof this.voiceProvider.synthesizeAssistantSpeech === "function") {
        try {
          confirmationTts = await this.voiceProvider.synthesizeAssistantSpeech(profileControlText, providerHooks, {
            // Tag the confirmation TTS with the SAME language the confirmation
            // text is written in (the gateway localizes canned text to the reply
            // language), so text language and TTS language can never diverge.
            language: turnReplyLanguage(turn, providerResult, canonicalRecord),
            // Confirmations speak with the same per-turn voice as the reply
            // (session_start override included), not the global default.
            profile: turn.effectiveProfile,
          });
        } catch {
          // The confirmation still shows as text; a synthesis fault is not fatal.
        }
      }
    } else if (assistantText && !providerEvents.assistantTextSent) {
      await providerHooks.onAssistantText(assistantText);
    }
    if (providerEvents.assistantAudioStarted && !providerEvents.assistantAudioDone) {
      await providerHooks.onAssistantAudioDone();
    }
    const firstAudioMs = Number.isFinite(providerResult?.first_audio_ms)
      ? Math.max(0, Math.round(providerResult.first_audio_ms))
      : (Number.isFinite(turn.firstAssistantAudioMs) ? turn.firstAssistantAudioMs : null);
    const completionMs = Math.max(0, elapsedMsSince(turn.startedAt));
    providerEvents.stageTimings.completion_ms = completionMs;
    if (Number.isFinite(firstAudioMs)) {
      providerEvents.stageTimings.first_audio_ms = firstAudioMs;
    }
    const doneModality = providerResult?.modality || confirmationTts?.modality || "";
    const ttsTerminal = summarizeTtsTerminal(
      providerResult, providerEvents, turn, assistantText, confirmationTts);
    const {
      complete: doneTtsComplete, delivery: doneTtsDelivery, error: doneTtsError,
      replyTextChars: doneTtsReplyTextChars, segments: doneTtsSegments,
      spokenTextEnd: doneTtsSpokenTextEnd, spoke: doneTtsSpoke,
    } = ttsTerminal;
    await this.recordProviderEvent(turn, providerEvents, "turn_completed", {
      transcript,
      assistant_text: assistantText,
      gateway_assistant_text: profileControlText || "",
      duration_ms: completionMs,
      stage_timings: sanitizeStageTimings(providerEvents.stageTimings),
      // Streaming latency observability: time to first PCM write and segment
      // count land per turn in voice-provider-events.jsonl for moa-voice-qa.
      ...(Number.isFinite(firstAudioMs) ? { first_audio_ms: firstAudioMs } : {}),
      ...(Number.isFinite(providerResult?.tts_segments) ? { tts_segments: providerResult.tts_segments } : {}),
      ...(Number.isFinite(providerResult?.reasoner_first_delta_ms) ? { reasoner_first_delta_ms: providerResult.reasoner_first_delta_ms } : {}),
      ...(doneTtsError ? { tts_error: doneTtsError } : {}),
      tts_delivery: doneTtsDelivery,
      tts_complete: doneTtsComplete,
      tts_segments: doneTtsSegments,
      tts_spoken_text_end: doneTtsSpokenTextEnd,
      tts_reply_text_chars: doneTtsReplyTextChars,
      ...(Number.isInteger(providerResult?.tts_failed_segment_index)
        ? { tts_failed_segment_index: providerResult.tts_failed_segment_index }
        : {}),
    });
    if (Array.isArray(providerResult?.actions)) {
      for (const action of providerResult.actions) {
        await this.emitClientAction(turn, action, "");
      }
    }
    this.stopTurnProgress();
    const hasPlaybackTail = turn.assistantAudioBytes > 0 && turn.assistantAudioSegments.length > 0;
    turn.status = hasPlaybackTail ? "playback" : "completed";
    turn.ttsRecovery = ["partial", "failed"].includes(doneTtsDelivery)
      && Number.isSafeInteger(doneTtsSpokenTextEnd)
      && doneTtsSpokenTextEnd >= 0
      && doneTtsSpokenTextEnd < doneTtsReplyTextChars
      ? { delivery: doneTtsDelivery, spokenTextEnd: doneTtsSpokenTextEnd,
        replyTextChars: doneTtsReplyTextChars, assistantText }
      : null;
    writeTurnMetadata(turn, { status: "completed", completed_at: nowIso() });
    await this.sendTurnDone({
      type: "turn_done",
      session_id: turn.sessionId,
      branch_id: turn.branchId,
      turn_id: turn.turnId,
      status: "completed",
      transcription_only: providerResult?.transcription_only === true,
      ...(typeof doneTtsSpoke === "boolean" ? { tts_spoke: doneTtsSpoke } : {}),
      reply_language: turnReplyLanguage(turn, providerResult, canonicalRecord),
      input_languages: turnInputLanguages(turn),
      ...(doneModality ? { modality: doneModality } : {}),
      ...(doneTtsError ? { tts_error: doneTtsError } : {}),
      tts_delivery: doneTtsDelivery,
      tts_complete: doneTtsComplete,
      tts_segments: doneTtsSegments,
      tts_spoken_text_end: doneTtsSpokenTextEnd,
      tts_reply_text_chars: doneTtsReplyTextChars,
      ...(Number.isInteger(providerResult?.tts_failed_segment_index)
        ? { tts_failed_segment_index: providerResult.tts_failed_segment_index }
        : {}),
      ...(providerResult?.streaming ? { streaming: true } : {}),
      ...(Number.isFinite(firstAudioMs) ? { first_audio_ms: firstAudioMs } : {}),
    });
    // the session so a barge-in during that tail can report its checkpoint.
    // Text-only turns still close immediately for old-client compatibility.
    if (turn.ttsRecovery) retainTtsRecoveryTurn(this, turn);
    if (!hasPlaybackTail && !turn.ttsRecovery && this.turn === turn) {
      this.turn = null;
    }
  }
  // Persist an interrupted/canceled/closed live turn into the SAME canonical
  // conversation record path as a completed turn, so whatever transcript or
  // assistant text the provider produced before the cutoff still carries
  // forward to the next turn and to the other device. Without this, an
  // interrupted Gemini Live turn only lands in observability logs and is lost
  // from the Moa-owned context pack.
  // Where speech stopped for an interrupted/canceled turn, from the
  // frame->text ledger plus (when the client reported it) the actual playback
  // position. Without a client report, "sent" is the upper bound for "heard".
  spokenProgressForTurn(turn) {
    const segments = Array.isArray(turn.assistantSegments) ? turn.assistantSegments : [];
    if (segments.length === 0) {
      return null;
    }
    let playedCount = segments.length;
    let clientReported = false;
    if (Number.isFinite(turn.clientPlayedSegments)) {
      playedCount = Math.min(Math.max(0, turn.clientPlayedSegments), segments.length);
      clientReported = true;
    } else if (Number.isFinite(turn.clientPlayedMs)) {
      // Android reports the AudioTrack playback clock; walk the per-segment
      // durations and count every segment whose audio had fully played.
      clientReported = true;
      playedCount = 0;
      let cumulativeMs = 0;
      for (const segment of segments) {
        cumulativeMs += Number(segment.ms) || 0;
        if (turn.clientPlayedMs + 50 < cumulativeMs) {
          break;
        }
        playedCount += 1;
      }
    }
    const spokenText = segments.slice(0, playedCount).map((segment) => segment.text).join(" ").trim();
    const unplayedText = segments.slice(playedCount).map((segment) => segment.text).join(" ").trim();
    return {
      segments_sent: segments.length,
      segments_played: playedCount,
      client_reported: clientReported,
      ...(Number.isFinite(turn.clientPlayedMs) ? { played_ms: turn.clientPlayedMs } : {}),
      spoken_text: spokenText,
      ...(unplayedText ? { unspoken_text: unplayedText } : {}),
    };
  }
  async recordIncompleteTurn(turn, status, errorMessage = "") {
    if (!turn || turn.recordedCanonical || !this.onTurnCompleted) {
      return;
    }
    if (turn.status === "completed") {
      return;
    }
    const providerEvents = turn.providerEvents || this.createProviderEvents(turn);
    const transcript = String(providerEvents.transcript || "").trim();
    const transcriptionOnly = turn.transcriptionOnly === true;
    const assistantText = transcriptionOnly ? "" : String(providerEvents.assistantText || "").trim();
    if (!transcript && !assistantText && turn.audioBytes <= 0 && turn.assistantAudioBytes <= 0) {
      return;
    }
    turn.recordedCanonical = true;
    const spokenProgress = this.spokenProgressForTurn(turn);
    try {
      return await this.onTurnCompleted({
        session_id: turn.sessionId,
        conversation_id: turn.conversationId || turn.sessionId,
        branch_id: turn.branchId || "default",
        turn_id: turn.turnId,
        profile_version: turn.profileVersion || "",
        device_id: turn.deviceId || "",
        source: turn.source,
        persona: turn.persona || null,
        started_at: turn.startedAt,
        completed_at: nowIso(),
        transcript: transcript || (turn.audioBytes > 0 ? "Voice captured." : ""), transcript_sequence: turn.transcriptSequence || 0,
        transcript_source: transcript ? "stt" : (turn.audioBytes > 0 ? "synthetic" : ""),
        assistant_text: assistantText,
        provider: turn.providerStatus?.provider || this.voiceProvider.status().provider,
        model: turn.providerStatus?.model || this.voiceProvider.status().model,
        audio_format: turn.format,
        assistant_audio_format: ASSISTANT_AUDIO_FORMAT,
        audio: {
          pcm_file: path.basename(turn.pcmPath),
          bytes: turn.audioBytes,
          chunks: turn.audioChunks,
        },
        assistant_audio: transcriptionOnly ? null : {
          pcm_file: path.basename(turn.assistantPcmPath),
          bytes: turn.assistantAudioBytes,
          chunks: turn.assistantAudioChunks,
        },
        context: turn.contextSummary || {},
        capture: turn.captureSummary || captureSummaryForTurn(turn),
        transport: turn.transportSummary || {},
        assistant_audio_segments: transcriptionOnly ? [] : turn.assistantAudioSegments,
        playback_policy: turn.playbackPolicy || {},
        playback_progress: turn.playbackProgress,
        transcription_only: transcriptionOnly,
        incomplete: true,
        status,
        error: errorMessage,
        ...(spokenProgress ? { spoken_progress: spokenProgress } : {}),
        stage_timings: sanitizeStageTimings(providerEvents.stageTimings),
        transcript_language_rejected: turn.transcriptLanguageRejected === true,
        input_languages: turnInputLanguages(turn),
        provider_events: Array.isArray(providerEvents.events) ? providerEvents.events : [],
        ...(turn.turnRelation ? { turn_relation: turn.turnRelation } : {}),
        ...(turn.invocationContext ? { invocation_context: turn.invocationContext } : {}),
      });
    } catch (error) {
      writeTurnMetadata(turn, {
        canonical_record_error: cleanError(error),
      });
      return null;
    }
  }

  async recordCompletedTurn(turn, providerResult, completed) {
    if (!this.onTurnCompleted) {
      return null;
    }
    turn.recordedCanonical = true;
    try {
      return await this.onTurnCompleted({
        session_id: turn.sessionId,
        conversation_id: turn.conversationId || turn.sessionId,
        branch_id: turn.branchId || "default",
        turn_id: turn.turnId,
        profile_version: turn.profileVersion || "",
        device_id: turn.deviceId || "",
        source: turn.source,
        persona: turn.persona || null,
        started_at: turn.startedAt,
        completed_at: nowIso(),
        transcript: completed.transcript,
        transcript_sequence: turn.transcriptSequence || 0,
        transcript_source: completed.transcriptSource || providerResult?.transcript_source || "",
        transcript_provider: providerResult?.transcript_provider || "",
        native_input_transcript: providerResult?.native_input_transcript || "",
        assistant_text: completed.assistantText,
        provider: providerResult?.provider || this.voiceProvider.status().provider,
        model: providerResult?.model || this.voiceProvider.status().model,
        audio_format: turn.format,
        assistant_audio_format: completed.assistantAudioFormat || ASSISTANT_AUDIO_FORMAT,
        audio: {
          pcm_file: path.basename(turn.pcmPath),
          bytes: turn.audioBytes,
          chunks: turn.audioChunks,
        },
        assistant_audio: {
          pcm_file: path.basename(turn.assistantPcmPath),
          bytes: turn.assistantAudioBytes,
          chunks: turn.assistantAudioChunks,
        },
        context: turn.contextSummary || {},
        capture: turn.captureSummary || captureSummaryForTurn(turn),
        transport: turn.transportSummary || {},
        assistant_audio_segments: turn.assistantAudioSegments,
        playback_policy: turn.playbackPolicy || {},
        transcription_only: providerResult?.transcription_only === true,
        // Cascaded pipeline: reply (OUTPUT) language and whether hosted TTS
        // actually spoke, so history records both and the client knows if it
        // must speak the reply text locally (e.g. Amharic).
        reply_language: providerResult?.reply_language || "",
        tts_spoke: providerResult?.tts_spoke === true,
        // How the reply was delivered ("text" = deliberately not spoken) and the
        // reason a hosted-TTS attempt failed, recorded on the canonical turn so
        // history distinguishes a text-only turn from a synthesis fault.
        modality: providerResult?.modality || "",
        tts_error: providerResult?.tts_error || "",
        // reading new records ignores these; new code reading old records
        // treats absence as the non-streaming default.
        ...(providerResult?.streaming ? { streaming: true } : {}),
        ...(Number.isFinite(providerResult?.first_audio_ms) ? { first_audio_ms: providerResult.first_audio_ms } : (
          Number.isFinite(turn.firstAssistantAudioMs) ? { first_audio_ms: turn.firstAssistantAudioMs } : {}
        )),
        ...(Number.isFinite(providerResult?.tts_segments) ? { tts_segments: providerResult.tts_segments } : {}),
        ...(providerResult?.tts_language_mismatch ? { tts_language_mismatch: true } : {}),
        stage_timings: sanitizeStageTimings(turn.providerEvents?.stageTimings),
        transcript_language_rejected: providerResult?.transcript_language_rejected === true || turn.transcriptLanguageRejected === true,
        // The restricted INPUT languages the STT leg recognized, captured at
        // session start. Recorded on the canonical turn so a later audio-analysis
        // agent can fetch the stored PCM and know both input and output languages.
        input_languages: turnInputLanguages(turn),
        provider_events: Array.isArray(turn.providerEvents?.events) ? turn.providerEvents.events : [],
        ...(turn.turnRelation ? { turn_relation: turn.turnRelation } : {}),
        ...(turn.invocationContext ? { invocation_context: turn.invocationContext } : {}),
      });
    } catch (error) {
      writeTurnMetadata(turn, {
        canonical_record_error: cleanError(error),
      });
      return null;
    }
  }

  async failLiveTurn(turn, error) {
    if (this.turn !== turn || TERMINAL_TURN_STATUSES.has(turn.status)) {
      return;
    }
    await this.failCommittedTurn(turn, turn.providerEvents || this.createProviderEvents(turn), error);
  }

  async failCommittedTurn(turn, providerEvents, error) {
    if (!turn || TERMINAL_TURN_STATUSES.has(turn.status)) {
      return;
    }
    if (isTurnSupersededError(error)) {
      // A superseded turn already got its terminal record from
      // closeCurrentTurn (barge-in). Broadcasting it as a turn error would
      // rebrand a normal interruption and emit events for the dead turn.
      return;
    }
    const message = cleanError(error);
    turn.status = "error";
    this.stopTurnProgress();
    await closeAudioStream(turn);
    await closeAssistantAudioStream(turn);
    if (turn.liveSession) turn.liveSession.cancel();
    abortSttStream(turn);
    const events = providerEvents || this.createProviderEvents(turn);
    const failedStage = events.activeStage
      || normalizeProgressStage(this.turnProgressStage)
      || "processing";
    if (!events.stageFailed && !events.events.some((event) => event.type === "stage_error")) {
      await this.recordProviderEvent(turn, events, "stage_error", {
        stage: normalizeStageName(failedStage),
        duration_ms: normalizeDurationMs(null, events.stageStartedAt?.[failedStage]),
        error_summary: cleanErrorSummary(message),
        reason: turnErrorReason(error),
      });
    }
    const completionMs = Math.max(0, elapsedMsSince(turn.startedAt));
    events.stageTimings.completion_ms = completionMs;
    await this.recordProviderEvent(turn, events, "turn_error", {
      error: message,
      error_summary: cleanErrorSummary(message),
      reason: turnErrorReason(error),
      duration_ms: completionMs,
      stage_timings: sanitizeStageTimings(events.stageTimings),
    });
    const incompleteRecord = await this.recordIncompleteTurn(turn, "error", message);
    writeTurnMetadata(turn, {
      status: "error",
      error: message,
      error_reason: turnErrorReason(error),
      completed_at: nowIso(),
    });
    if (!turn.finalizeTranscriptOnly) {
      this.sendError(`failed to complete turn: ${message}`);
    }
    await this.sendTurnDone({
      type: turn.finalizeTranscriptOnly ? "transcript_finalized" : "turn_done",
      session_id: turn.sessionId,
      branch_id: turn.branchId,
      turn_id: turn.turnId,
      status: "error",
      ...(turn.finalizeTranscriptOnly ? {
        transcript: String(events.transcript || "").trim(),
        transcription_only: true,
        stored: Boolean(incompleteRecord),
      } : {}),
      reason: turnErrorReason(error),
      error_summary: cleanErrorSummary(message),
      reply_language: turnReplyLanguage(turn, null, null),
      input_languages: turnInputLanguages(turn),
    });
    if (this.turn === turn) {
      this.turn = null;
    }
  }

  async sendTurnDone(payload) {
    try {
      await this.sendEvent(payload);
    } catch {
      // The client may already have closed during interruption/replacement. The
      // canonical turn and provider event are the recovery record; do not let a
      // terminal notification failure keep the server-side turn open.
    }
  }

  async handleCancelTurn(event) {
    const turn = this.currentTurnFor(event.turn_id);
    if (!turn) {
      return;
    }

    const playedSegments = Number(event.played_segments);
    if (Number.isFinite(playedSegments) && playedSegments >= 0) {
      turn.clientPlayedSegments = Math.floor(playedSegments);
    }
    const playedMs = Number(event.played_ms);
    if (Number.isFinite(playedMs) && playedMs >= 0) {
      turn.clientPlayedMs = Math.floor(playedMs);
    }

    const replacementKind = String(event.replacement_kind || "").trim();
    if (replacementKind === "steering" || replacementKind === "fresh_thread") {
      const nextTurnId = sanitizeId(event.next_turn_id, "next_turn_id");
      const boundaryId = sanitizeId(event.boundary_id, "boundary_id");
      const relation = planVoiceTurnRelation(turn, {
        sessionId: turn.sessionId,
        conversationId: turn.conversationId || turn.sessionId,
        branchId: replacementKind === "fresh_thread" ? "pending-fresh" : turn.branchId,
        turnId: nextTurnId,
        deviceId: turn.deviceId,
        contextAction: replacementKind === "fresh_thread" ? "new" : "",
      }, { boundaryId, occurredAt: nowIso() });
      turn.turnRelation = relation.prior;
      this.steeringCoordinator.store(nextTurnId, {
        owner: {
          sessionId: turn.sessionId,
          conversationId: turn.conversationId || turn.sessionId,
          deviceId: turn.deviceId,
        },
        next: relation.next,
      });
      await this.closeCurrentTurn("interrupted");
      return;
    }

    if (hasPartialEndpointPlayback(turn)) {
      turn.recordedCanonical = false;
    }
    const legacyProgress = this.spokenProgressForTurn(turn);
    if (legacyProgress?.client_reported && legacyProgress.segments_played < legacyProgress.segments_sent) {
      turn.recordedCanonical = false;
    }
    turn.status = "canceled";
    await this.phraseAssist.stop(turn);
    this.stopTurnProgress();
    await closeAudioStream(turn);
    await closeAssistantAudioStream(turn);
    if (turn.liveSession) turn.liveSession.cancel();
    abortSttStream(turn);
    await this.recordProviderEvent(turn, turn.providerEvents || this.createProviderEvents(turn), "turn_canceled", {});
    await this.recordIncompleteTurn(turn, "canceled");
    writeTurnMetadata(turn, {
      status: "canceled",
      canceled_at: nowIso(),
    });
    await this.sendEvent({
      type: "turn_done",
      session_id: turn.sessionId,
      branch_id: turn.branchId,
      turn_id: turn.turnId,
      status: "canceled",
      reply_language: turnReplyLanguage(turn, null, null),
      input_languages: turnInputLanguages(turn),
    });
    this.turn = null;
  }

  async handlePlaybackProgress(event) {
    const turn = this.currentTurnFor(event.turn_id);
    if (!turn) {
      return;
    }
    if (!ACTIVE_PLAYBACK_PROGRESS_STATUSES.has(turn.status)) {
      this.sendError(`turn is not accepting playback progress: ${turn.status}`);
      return;
    }
    const progress = normalizePlaybackProgress(event, turn);
    if (!progress) {
      this.sendError("playback_progress requires bounded played_pcm_ms or played_audio_bytes for the active turn");
      return;
    }
    turn.playbackProgress = progress;
    await this.recordProviderEvent(turn, turn.providerEvents || this.createProviderEvents(turn), "playback_progress", progress);
    writeTurnMetadata(turn, {
      playback_progress: progress,
    });
  }

  currentTurnFor(turnId) {
    if (!this.turn) {
      this.sendError("no active turn");
      return null;
    }

    if (turnId) {
      let requestedTurnId;
      try {
        requestedTurnId = sanitizeId(turnId, "turn_id");
      } catch (error) {
        this.sendError(cleanError(error));
        return null;
      }
      if (requestedTurnId !== this.turn.turnId) {
        this.sendError(`turn_id does not match active turn: ${requestedTurnId}`);
        return null;
      }
    }

    return this.turn;
  }

  async closeCurrentTurn(status) {
    this.stopTurnProgress();
    if (!this.turn) {
      return;
    }

    const turn = this.turn;
    if (turn.ttsRecovery && turn.status === "completed") return releaseTtsRecoveryTurn(this, turn);
    const providerEvents = turn.providerEvents || this.createProviderEvents(turn);
    if (turn.status !== "recording" && hasPartialEndpointPlayback(turn)) turn.recordedCanonical = false;
    await this.phraseAssist.stop(turn);
    turn.status = status;
    await closeAudioStream(turn);
    await closeAssistantAudioStream(turn);
    if (turn.liveSession) {
      turn.liveSession.cancel();
    }
    abortSttStream(turn);
    await this.recordProviderEvent(turn, providerEvents, status === "interrupted" ? "interruption" : "turn_closed", {
      status,
      ...(turn.turnRelation ? { turn_relation: turn.turnRelation } : {}),
    });
    await this.recordIncompleteTurn(turn, status);
    writeTurnMetadata(turn, {
      status,
      closed_at: nowIso(),
    });
    this.turn = null;
  }

  async recordProviderEvent(turn, providerEvents, type, payload) {
    if (!turn) {
      return;
    }
    const status = turn.providerStatus || this.voiceProvider.status();
    const event = {
      id: randomId("voice_evt"),
      ts: nowIso(),
      type,
      session_id: turn.sessionId,
      conversation_id: turn.conversationId || turn.sessionId,
      branch_id: turn.branchId || "default",
      turn_id: turn.turnId,
      profile_version: turn.profileVersion || "",
      device_id: turn.deviceId || "",
      provider: status.provider || "",
      provider_ids: status.selected_providers || {
        native_live: status.provider || "",
        stt: status.stt_provider || "",
        reasoning: status.reasoning_provider || status.llm_provider || "",
        tts: status.tts_provider || "",
      },
      provider_bundle: turn.providerBundle || "",
      ...(payload || {}),
    };
    if (providerEvents && Array.isArray(providerEvents.events)) {
      providerEvents.events.push(event);
    }
    writeTurnMetadata(turn, {
      provider_events: providerEvents?.events || [event],
    });
    try {
      fs.appendFileSync(this.providerEventsFile, `${JSON.stringify(event)}\n`);
    } catch {
      // Provider event persistence is observability; do not fail the turn.
    }
  }

  async sendEvent(payload) {
    await sendWs(this.ws, JSON.stringify(payload));
  }


  sendError(message) {
    if (this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.ws.send(JSON.stringify({
      type: "error",
      message,
    }));
  }
}

// The configured INPUT prompt-language codes for a turn, captured at session
// start, so clients render "hears X" without mistaking auto-detection for a preference.
function turnInputLanguages(turn) {
  const codes = turn?.providerStatus?.prompt_language_codes || turn?.providerStatus?.language_codes;
  return Array.isArray(codes) ? codes.filter(Boolean).map((code) => String(code)) : [];
}

// The reply (OUTPUT) language for a turn, so turn_done and the profile-control
// confirmation TTS always carry a language code even when the provider result
// omits it: provider result -> canonical record -> the turn's effective profile
// reply language -> the first configured STT prompt language. This keeps the
// spoken text's language and its TTS language tag from ever diverging, and lets
// clients show "speaks Y" every turn.
function turnReplyLanguage(turn, providerResult, canonicalRecord) {
  const fromProvider = String(providerResult?.reply_language || "").trim();
  if (fromProvider) {
    return fromProvider;
  }
  const fromRecord = String(
    canonicalRecord?.response?.reply_language || canonicalRecord?.reply_language || "",
  ).trim();
  if (fromRecord) {
    return fromRecord;
  }
  const profile = turn?.effectiveProfile || null;
  const fromProfile = String(profile?.language_primary || profile?.language || "").trim();
  if (fromProfile) {
    return fromProfile.split(",")[0].trim();
  }
  return turnInputLanguages(turn)[0] || "";
}

function profileControlAssistantText(record) {
  if (!record || typeof record !== "object") {
    return "";
  }
  if (record.classification !== "profile_control" && record.response?.classification !== "profile_control") {
    return "";
  }
  return String(record.response?.display || record.response?.speak || record.display || record.speak || "").trim();
}

function normalizeFormat(format) {
  const input = format && typeof format === "object" ? format : {};
  const encoding = String(input.encoding || "pcm16").toLowerCase();
  const sampleRate = Number(input.sample_rate || 16000);
  const channels = Number(input.channels || 1);

  if (encoding !== "pcm16") {
    throw new Error("voice sessions currently accept only pcm16 input");
  }
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error("format.sample_rate must be a positive number");
  }
  if (!Number.isFinite(channels) || channels <= 0) {
    throw new Error("format.channels must be a positive number");
  }

  return {
    encoding,
    sample_rate: Math.round(sampleRate),
    channels: Math.round(channels),
  };
}

function normalizePlaybackPolicy(policy) {
  const input = policy && typeof policy === "object" && !Array.isArray(policy) ? policy : {};
  return {
    assistant_overlap: input.assistant_overlap === true,
  };
}

function contextSummaryForTurn(turn, contextProvider) {
  return {
    enabled: typeof contextProvider === "function",
    build_failed: turn?.contextBuildFailed === true,
    chars: String(turn?.contextPrompt || "").length,
    all_branches_context: turn?.allBranchesContext === true,
    invocation_context_digest: turn?.invocationContext?.digest || "",
  };
}

function captureSummaryForTurn(turn, options = {}) {
  const textChars = Math.max(0, Math.round(Number(options.textChars) || 0));
  const inputKind = String(options.inputKind || (textChars > 0 ? "text" : (Number(turn?.audioBytes) > 0 ? "audio" : "unknown")));
  return {
    input_kind: inputKind,
    audio_bytes: Math.max(0, Number(turn?.audioBytes) || 0),
    audio_chunks: Math.max(0, Number(turn?.audioChunks) || 0),
    ...(textChars > 0 ? { text_chars: textChars } : {}),
  };
}

function transportSummaryForTurn(turn, inputKind) {
  return {
    transport: turn?.liveSession ? "websocket_live" : "websocket_process_turn",
    input_kind: String(inputKind || "audio"),
    committed: true,
  };
}

// A session may speak AS a companion (a website pet, a picked character): a
// bounded per-session persona from session_start, treated as untrusted client
// input — sanitized, hard-capped, session-scoped, never written to the stored
// profile. The reasoner turns it into one extra system block for this session's
// turns only.
function personaForSession(event) {
  const raw = event?.persona && typeof event.persona === "object" && !Array.isArray(event.persona)
    ? event.persona
    : {};
  const name = sanitizePersonaText(raw.name || event?.assistant_name || "", 80);
  const text = sanitizePersonaText(raw.text || raw.summary || "", 400);
  if (!name && !text) {
    return null;
  }
  return { name, text };
}

function sanitizePersonaText(value, max) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function effectiveProfileForSession(profile, event) {
  const base = profile && typeof profile === "object" ? profile : {};
  const override = event?.profile_override && typeof event.profile_override === "object" && !Array.isArray(event.profile_override)
    ? event.profile_override
    : event?.profileOverride && typeof event.profileOverride === "object" && !Array.isArray(event.profileOverride)
      ? event.profileOverride
      : {};
  const next = { ...base };
  const voice = canonicalVoice(String(override.voice || event?.voice || ""));
  if (voice) {
    next.voice = voice;
  }
  const modality = String(override.response_modality || override.responseModality || "").trim().toLowerCase();
  if (modality === "speech" || modality === "text" || modality === "auto") {
    next.response_modality = modality;
  }
  // Session-scoped delivery controls (a pet that talks fast, a slow-reader
  // mode): same validation band as the profile store, never persisted.
  const rate = Number(override.speaking_rate ?? override.speakingRate);
  if (Number.isFinite(rate) && rate >= 0.5 && rate <= 2) {
    next.speaking_rate = Math.round(rate * 100) / 100;
  }
  const tone = sanitizePersonaText(override.voice_tone ?? override.voiceTone ?? "", 160);
  if (tone) {
    next.voice_tone = tone;
  }
  return next;
}

// Tear down the streaming STT recognizer without finalizing (cancel/close/
// interrupt paths). The commit path finalizes via runSttStage instead; here the
// turn is terminal, so we just destroy the gRPC stream. Best-effort, never
// throws — a streaming fault must never take the session down.
function abortSttStream(turn) {
  if (!turn || !turn.sttStream) {
    turn?.transcriptReconciler?.abandon();
    return;
  }
  turn.transcriptReconciler?.abandon();
  const stream = turn.sttStream;
  turn.sttStream = null;
  try {
    stream.abort?.();
  } catch {
    // best effort
  }
}

async function closeAudioStream(turn) {
  if (!turn.audioStream) {
    return;
  }

  const stream = turn.audioStream;
  turn.audioStream = null;
  await new Promise((resolve, reject) => {
    stream.once("error", reject);
    stream.end(resolve);
  });
  // Spool is final for this turn — hand it to the write-behind uploader.
  // Fire-and-forget: the uploader owns retries, and incognito deletion later
  // tombstones any pending upload.
  if (turn.blobStore && turn.audioBytes > 0) {
    turn.blobStore.finalizeSpool(turn.userAudioKey, {
      contentType: "audio/L16; rate=16000; channels=1",
    });
  }
}

async function commitLiveSession(turn) {
  turn.liveSession.commit();
  return turn.liveSession.done;
}

async function commitLiveTextSession(turn, text) {
  turn.liveSession.sendText(text);
  return turn.liveSession.done;
}

async function writeAssistantAudio(turn, chunk) {
  const value = toBuffer(chunk);
  if (value.length === 0) {
    return false;
  }
  // Null-guard, mirroring the 2026-07-06 writeTurnAudio crash-loop fix: once
  // closeAssistantAudioStream finalized the stream (barge-in, cancel, close,
  // completion), a late streamed chunk is stale output. Drop it — re-creating
  // the stream with flags:"w" here would silently wipe the stored PCM of a
  // finalized turn, and throwing would take the whole session down.
  if (turn.assistantAudioClosed || TERMINAL_TURN_STATUSES.has(turn.status)) {
    return false;
  }
  if (!turn.assistantAudioStream) {
    turn.assistantAudioStream = fs.createWriteStream(turn.assistantPcmPath, { flags: "w" });
    turn.assistantAudioStream.on("error", (error) => {
      turn.status = "error";
      writeTurnMetadata(turn, { status: "error", error: cleanError(error) });
    });
  }
  turn.assistantAudioBytes += value.length;
  turn.assistantAudioChunks += 1;
  turn.lastAssistantAudioAt = nowIso();
  if (!turn.assistantAudioStream.write(value)) {
    await new Promise((resolve) => {
      turn.assistantAudioStream.once("drain", resolve);
    });
  }
  return true;
}

async function closeAssistantAudioStream(turn) {
  // Latch first: even when no stream was ever opened, the assistant-audio
  // lifecycle for this turn is over and a late chunk must not re-open it.
  turn.assistantAudioClosed = true;
  if (!turn.assistantAudioStream) {
    return;
  }

  const stream = turn.assistantAudioStream;
  turn.assistantAudioStream = null;
  await new Promise((resolve, reject) => {
    stream.once("error", reject);
    stream.end(resolve);
  });
  if (turn.blobStore && turn.assistantAudioBytes > 0) {
    turn.blobStore.finalizeSpool(turn.assistantAudioKey, {
      contentType: "audio/L16; rate=16000; channels=1",
    });
  }
}

function writeTurnMetadata(turn, patch) {
  const previous = turn.metadata || {};
  const next = {
    ...previous,
    ...patch,
    session_id: turn.sessionId,
    conversation_id: turn.conversationId || turn.sessionId,
    branch_id: turn.branchId || "default",
    turn_id: turn.turnId,
    profile_version: turn.profileVersion || previous.profile_version || "",
    provider: turn.providerStatus?.provider || previous.provider || "",
    provider_ids: turn.providerStatus?.selected_providers || previous.provider_ids || {},
    provider_bundle: turn.providerBundle || previous.provider_bundle || "",
    source: turn.source,
    input_format: turn.format,
    playback_policy: turn.playbackPolicy || previous.playback_policy || {},
    context: turn.contextSummary || previous.context || {},
    invocation_context: turn.invocationContext || previous.invocation_context || null,
    capture: turn.captureSummary || previous.capture || captureSummaryForTurn(turn),
    transport: turn.transportSummary || previous.transport || {},
    status: patch.status || previous.status || turn.status,
    started_at: turn.startedAt,
    updated_at: nowIso(),
    audio: {
      ...(previous.audio || {}),
      pcm_file: path.basename(turn.pcmPath),
      bytes: turn.audioBytes,
      chunks: turn.audioChunks,
      last_audio_at: turn.lastAudioAt,
    },
    assistant_audio: {
      ...(previous.assistant_audio || {}),
      pcm_file: path.basename(turn.assistantPcmPath),
      bytes: turn.assistantAudioBytes,
      chunks: turn.assistantAudioChunks,
      last_audio_at: turn.lastAssistantAudioAt,
    },
    provider_events: patch.provider_events || previous.provider_events || [],
    assistant_audio_segments: patch.assistant_audio_segments || previous.assistant_audio_segments || turn.assistantAudioSegments || [],
    playback_progress: patch.playback_progress || previous.playback_progress || turn.playbackProgress || null,
    turn_relation: patch.turn_relation || previous.turn_relation || turn.turnRelation || null,
  };

  turn.metadata = next;
  const tmpPath = `${turn.metadataPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(next, null, 2));
  fs.renameSync(tmpPath, turn.metadataPath);
}

function sendWs(ws, data, options) {
  if (ws.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error("websocket is not open"));
  }

  return new Promise((resolve, reject) => {
    ws.send(data, options || {}, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function toBuffer(data) {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data.map(toBuffer));
  }
  return Buffer.from(data);
}

function sanitizeLooseId(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 160);
}

function sanitizeId(value, field) {
  const safe = String(value || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 160);
  if (!safe) {
    throw new Error(`${field} is invalid`);
  }
  return safe;
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

function normalizeStageName(stage) {
  const value = String(stage || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return value || "unknown";
}

function sanitizeStageDetails(details) {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return {};
  }
  const output = {};
  for (const [rawKey, rawValue] of Object.entries(details)) {
    const key = String(rawKey || "")
      .trim()
      .replace(/[^a-zA-Z0-9_.:-]+/g, "_")
      .slice(0, 80);
    if (!key || rawValue === undefined || typeof rawValue === "function") {
      continue;
    }
    if (key === "error" || key === "error_summary") {
      output[key] = cleanErrorSummary(rawValue);
      continue;
    }
    if (typeof rawValue === "number") {
      if (Number.isFinite(rawValue)) {
        output[key] = Math.max(0, Math.round(rawValue));
      }
      continue;
    }
    if (typeof rawValue === "boolean") {
      output[key] = rawValue;
      continue;
    }
    if (Array.isArray(rawValue)) {
      output[key] = rawValue
        .slice(0, 8)
        .map((item) => String(item || "").replace(/[\r\n]+/g, " ").slice(0, 80));
      continue;
    }
    if (rawValue && typeof rawValue === "object") {
      output[key] = JSON.stringify(rawValue).replace(/[\r\n]+/g, " ").slice(0, PROVIDER_EVENT_VALUE_MAX_CHARS);
      continue;
    }
    output[key] = String(rawValue || "").replace(/[\r\n]+/g, " ").slice(0, PROVIDER_EVENT_VALUE_MAX_CHARS);
  }
  return output;
}

function normalizeDurationMs(value, startedAtMs) {
  const explicit = Number(value);
  if (Number.isFinite(explicit) && explicit >= 0) {
    return Math.round(explicit);
  }
  const started = Number(startedAtMs);
  if (Number.isFinite(started) && started > 0) {
    return Math.max(0, Date.now() - started);
  }
  return 0;
}

function elapsedMsSince(iso) {
  const started = Date.parse(iso || "");
  if (!Number.isFinite(started)) {
    return 0;
  }
  return Math.max(0, Date.now() - started);
}

function sanitizeStageTimings(timings) {
  if (!timings || typeof timings !== "object" || Array.isArray(timings)) {
    return {};
  }
  const output = {};
  for (const [rawKey, rawValue] of Object.entries(timings)) {
    const key = String(rawKey || "")
      .trim()
      .replace(/[^a-zA-Z0-9_.:-]+/g, "_")
      .slice(0, 80);
    const value = Number(rawValue);
    if (key && Number.isFinite(value) && value >= 0) {
      output[key] = Math.round(value);
    }
  }
  return output;
}

function cleanErrorSummary(error) {
  return cleanError(error).slice(0, PROVIDER_EVENT_ERROR_MAX_CHARS);
}

function cleanError(error) {
  return String(error?.message || error || "unknown error").replace(/[\r\n]+/g, " ").slice(0, 500);
}

function turnErrorReason(error) {
  const message = cleanError(error).toLowerCase();
  if (error?.name === "AbortError" || message.includes("timeout") || message.includes("timed out")) {
    return "timeout";
  }
  if (message.includes("no speech") || message.includes("empty audio")) {
    return "stt_empty";
  }
  return "processing_error";
}

function normalizeTurnProgressIntervalMs(value) {
  const explicit = Number(value);
  if (Number.isFinite(explicit) && explicit >= 0) {
    return Math.round(explicit);
  }
  const fromEnv = Number(process.env.MOA_VOICE_TURN_PROGRESS_MS);
  if (Number.isFinite(fromEnv) && fromEnv >= 0) {
    return Math.round(fromEnv);
  }
  return DEFAULT_TURN_PROGRESS_INTERVAL_MS;
}

// Bind the extracted playback-progress helpers to this server's audio format
// and provider-event text cap.
function normalizeAssistantAudioSegment(segment, existingSegments) {
  return normalizeSegmentRaw(segment, existingSegments, {
    format: ASSISTANT_AUDIO_FORMAT,
    maxTextChars: PROVIDER_EVENT_VALUE_MAX_CHARS,
  });
}

function normalizePlaybackProgress(event, turn) {
  return normalizeProgressRaw(event, turn, {
    format: ASSISTANT_AUDIO_FORMAT,
    maxTextChars: PROVIDER_EVENT_VALUE_MAX_CHARS,
  });
}

function nowIso() {
  return new Date().toISOString();
}

module.exports = {
  VOICE_SESSION_ENDPOINT,
  TurnSupersededError,
  createVoiceSessionServer,
  generatePcm16Tone: generateProviderTone,
  VoiceSessionConnection,
};
