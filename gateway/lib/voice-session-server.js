"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { WebSocket, WebSocketServer } = require("ws");
const {
  CLIENT_AUDIO_FORMAT,
  createVoiceProvider,
  generatePcm16Tone: generateProviderTone,
} = require("./voice-providers");
const { canonicalVoice } = require("./profile-options");

const VOICE_SESSION_ENDPOINT = "/v1/voice/sessions";
const ASSISTANT_AUDIO_FORMAT = CLIENT_AUDIO_FORMAT;

function createVoiceSessionServer(options) {
  const dataDir = path.resolve(options?.dataDir || "./data");
  const sessionsDir = path.join(dataDir, "voice-sessions");
  const providerEventsFile = path.join(dataDir, "voice-provider-events.jsonl");
  const agentProfile = options?.agentProfile || null;
  const contextProvider = typeof options?.contextProvider === "function" ? options.contextProvider : null;
  const toolHandler = typeof options?.toolHandler === "function" ? options.toolHandler : null;
  const voiceProvider = options?.voiceProvider || createVoiceProvider({
    env: options?.env || process.env,
    systemPrompt: options?.systemPrompt,
    // Pass the runtime agent profile so the provider reads the effective `voice`
    // per session — the agent can change its own spoken voice by talking.
    agentProfile: options?.agentProfile,
  });
  fs.mkdirSync(sessionsDir, { recursive: true });

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: Number(options?.maxPayloadBytes || 2 * 1024 * 1024),
  });

  wss.on("connection", (ws, request) => {
    const connection = new VoiceSessionConnection(ws, {
      request,
      sessionsDir,
      providerEventsFile,
      voiceProvider,
      agentProfile,
      contextProvider,
      toolHandler,
      onTurnCompleted: typeof options?.onTurnCompleted === "function" ? options.onTurnCompleted : null,
    });
    connection.start();
  });

  return {
    endpoint: VOICE_SESSION_ENDPOINT,
    sessionsDir,
    providerEventsFile,
    status() {
      return voiceProvider.status();
    },
    handleUpgrade(request, socket, head) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    },
    close(callback) {
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
    this.voiceProvider = options.voiceProvider;
    this.agentProfile = options.agentProfile || null;
    this.contextProvider = options.contextProvider || null;
    this.toolHandler = options.toolHandler || null;
    this.onTurnCompleted = options.onTurnCompleted || null;
    this.turn = null;
    this.responding = false;
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
      void this.closeCurrentTurn("closed");
    });
    this.ws.on("error", () => {
      void this.closeCurrentTurn("error");
    });
  }

  profileVersion(deviceId = "") {
    const value = this.agentProfile && typeof this.agentProfile.currentVersion === "function"
      ? this.agentProfile.currentVersion(deviceId ? { deviceId } : {})
      : "profile_v0001";
    try {
      return sanitizeId(value, "profile_version");
    } catch {
      return "profile_v0001";
    }
  }

  effectiveProfile(deviceId = "") {
    return this.agentProfile && typeof this.agentProfile.effective === "function"
      ? this.agentProfile.effective(deviceId ? { deviceId } : {})
      : null;
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
    if (type === "text_turn") {
      await this.handleTextTurn(event);
      return;
    }
    if (type === "cancel_turn") {
      await this.handleCancelTurn(event);
      return;
    }
    this.sendError(`unsupported voice event type: ${type || "missing"}`);
  }

  handleAudio(data) {
    if (!this.turn || this.turn.status !== "recording") {
      // Mobile/browser capture can deliver a final buffered PCM chunk after the
      // client has committed the turn or after a live reply has completed. That
      // frame is stale input, not a session failure; sending an error here makes
      // clients tear down continuous voice after one response.
      return;
    }

    const chunk = toBuffer(data);
    if (chunk.length === 0) {
      return;
    }
    if (chunk.length % 2 !== 0) {
      this.sendError("pcm16 audio frames must contain an even number of bytes");
      return;
    }

    this.turn.audioBytes += chunk.length;
    this.turn.audioChunks += 1;
    this.turn.lastAudioAt = nowIso();
    this.turn.audioStream.write(chunk);
    if (this.turn.liveSession) {
      this.turn.liveSession.sendAudio(chunk);
    }
  }

  async handleSessionStart(event) {
    if (this.responding) {
      await this.closeCurrentTurn("interrupted");
      this.responding = false;
    }

    await this.closeCurrentTurn("replaced");

    const sessionId = sanitizeId(event.session_id || randomId("session"), "session_id");
    const conversationId = sanitizeId(event.conversation_id || sessionId, "conversation_id");
    const branchId = sanitizeId(event.branch_id || "default", "branch_id");
    const turnId = sanitizeId(event.turn_id || randomId("turn"), "turn_id");
    const turnDir = path.join(this.sessionsDir, sessionId);
    const format = normalizeFormat(event.format);
    const playbackPolicy = normalizePlaybackPolicy(event.playback_policy || event.playbackPolicy);
    const allBranchesContext = event.all_branches_context === true || event.allBranchesContext === true;
    const deviceId = sanitizeLooseId(event.device_id || event.deviceId || event.client?.device_id || event.client?.deviceId || "");
    const startedAt = nowIso();
    const profileVersion = this.profileVersion(deviceId);
    const effectiveProfile = effectiveProfileForSession(this.effectiveProfile(deviceId), event);
    const providerStatus = this.voiceProvider.status();
    fs.mkdirSync(turnDir, { recursive: true });

    const turn = {
      sessionId,
      conversationId,
      branchId,
      turnId,
      profileVersion,
      effectiveProfile,
      providerStatus,
      deviceId,
      source: String(event.source || "android-overlay").slice(0, 120),
      format,
      playbackPolicy,
      allBranchesContext,
      turnDir,
      pcmPath: path.join(turnDir, `${turnId}.pcm`),
      assistantPcmPath: path.join(turnDir, `${turnId}.assistant.pcm`),
      metadataPath: path.join(turnDir, `${turnId}.json`),
      startedAt,
      lastAudioAt: null,
      lastAssistantAudioAt: null,
      status: "recording",
      audioBytes: 0,
      audioChunks: 0,
      assistantAudioBytes: 0,
      assistantAudioChunks: 0,
      metadata: {},
      audioStream: null,
      assistantAudioStream: null,
      providerEvents: null,
      liveSession: null,
      completing: false,
      recordedCanonical: false,
      contextPrompt: "",
      syntheticText: "",
    };
    turn.contextPrompt = this.contextPromptForTurn(turn);

    turn.audioStream = fs.createWriteStream(turn.pcmPath, { flags: "w" });
    turn.audioStream.on("error", (error) => {
      turn.status = "error";
      writeTurnMetadata(turn, { status: "error", error: cleanError(error) });
      this.sendError(`failed to write audio: ${cleanError(error)}`);
    });

    this.turn = turn;
    if (typeof this.voiceProvider.createLiveTurnSession === "function") {
      turn.providerEvents = this.createProviderEvents(turn);
      // createLiveTurnSession opens the provider socket but returns immediately;
      // it does not block on provider readiness, so session_ready below is not
      // gated on the Live cold start. Inbound audio is buffered client-side
      // until session_ready and, once the live session exists, queued behind the
      // provider's own readiness promise. A synchronous throw here (misconfig,
      // bad auth) must fail this turn with a visible error, not a generic catch.
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
    writeTurnMetadata(turn, { status: "recording" });
    await this.sendEvent({
      type: "session_ready",
      session_id: sessionId,
      branch_id: branchId,
      turn_id: turnId,
      playback_policy: playbackPolicy,
    });
    turn.providerEvents = turn.providerEvents || this.createProviderEvents(turn);
    await this.recordProviderEvent(turn, turn.providerEvents, "profile_applied", {
      application: "turn_start",
    });
    await this.sendEvent({
      type: "profile_applied",
      session_id: sessionId,
      branch_id: branchId,
      turn_id: turnId,
      profile_version: profileVersion,
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
      return "";
    }
  }

  async handleCommitTurn(event) {
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

    this.responding = true;
    const providerEvents = turn.providerEvents || this.createProviderEvents(turn);
    turn.providerEvents = providerEvents;
    const providerHooks = this.providerHooks(turn, providerEvents);

    try {
      turn.status = "committed";
      await closeAudioStream(turn);
      const providerResult = turn.liveSession
        ? await commitLiveSession(turn)
        : await this.voiceProvider.processTurn(turn, providerHooks);
      if (this.turn !== turn || turn.completing) {
        return;
      }
      turn.completing = true;
      await this.completeTurnWithProviderResult(turn, providerEvents, providerResult);
    } catch (error) {
      turn.status = "error";
      await closeAssistantAudioStream(turn);
      await this.recordProviderEvent(turn, providerEvents, "turn_error", {
        error: cleanError(error),
      });
      writeTurnMetadata(turn, {
        status: "error",
        error: cleanError(error),
      });
      this.sendError(`failed to complete turn: ${cleanError(error)}`);
    } finally {
      this.responding = false;
    }
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
    if (!turn.liveSession || typeof turn.liveSession.sendText !== "function") {
      this.sendError("voice provider does not support text_turn");
      return;
    }

    this.responding = true;
    const providerEvents = turn.providerEvents || this.createProviderEvents(turn);
    turn.providerEvents = providerEvents;

    try {
      turn.status = "committed";
      turn.syntheticText = text;
      await closeAudioStream(turn);
      const providerResult = await commitLiveTextSession(turn, text);
      if (this.turn !== turn || turn.completing) {
        return;
      }
      turn.completing = true;
      await this.completeTurnWithProviderResult(turn, providerEvents, providerResult);
    } catch (error) {
      turn.status = "error";
      await closeAssistantAudioStream(turn);
      await this.recordProviderEvent(turn, providerEvents, "turn_error", {
        error: cleanError(error),
      });
      writeTurnMetadata(turn, {
        status: "error",
        error: cleanError(error),
      });
      this.sendError(`failed to complete turn: ${cleanError(error)}`);
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
      events: Array.isArray(turn?.providerEvents?.events) ? turn.providerEvents.events : [],
    };
  }

  providerHooks(turn, providerEvents) {
    return {
      onTranscriptPartial: async (text) => {
        const value = String(text || "").trim();
        if (!value) return;
        providerEvents.transcript = value;
        await this.recordProviderEvent(turn, providerEvents, "transcript_partial", { text: value });
        await this.sendEvent({
          type: "transcript_partial",
          session_id: turn.sessionId,
          branch_id: turn.branchId,
          turn_id: turn.turnId,
          text: value,
        });
      },
      onTranscriptFinal: async (text) => {
        const value = String(text || "").trim();
        if (!value) return;
        providerEvents.transcript = value;
        providerEvents.transcriptFinalSent = true;
        await this.recordProviderEvent(turn, providerEvents, "transcript_final", { text: value });
        await this.sendEvent({
          type: "transcript_final",
          session_id: turn.sessionId,
          branch_id: turn.branchId,
          turn_id: turn.turnId,
          text: value,
        });
      },
      onAssistantText: async (text) => {
        const value = String(text || "").trim();
        if (!value) return;
        providerEvents.assistantText = value;
        providerEvents.assistantTextSent = true;
        await this.recordProviderEvent(turn, providerEvents, "assistant_text", { text: value });
        await this.sendEvent({
          type: "assistant_text",
          session_id: turn.sessionId,
          branch_id: turn.branchId,
          turn_id: turn.turnId,
          text: value,
        });
      },
      onAssistantAudioStart: async (format) => {
        providerEvents.assistantAudioStarted = true;
        await this.recordProviderEvent(turn, providerEvents, "assistant_audio_start", { format: format || ASSISTANT_AUDIO_FORMAT });
        await this.sendEvent({
          type: "assistant_audio_start",
          session_id: turn.sessionId,
          branch_id: turn.branchId,
          turn_id: turn.turnId,
          format: format || ASSISTANT_AUDIO_FORMAT,
        });
      },
      sendAudio: async (chunk) => {
        await writeAssistantAudio(turn, chunk);
        await sendWs(this.ws, chunk, { binary: true });
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
      onAssistantAudioDone: async () => {
        providerEvents.assistantAudioDone = true;
        await this.recordProviderEvent(turn, providerEvents, "assistant_audio_done", {});
        await this.sendEvent({
          type: "assistant_audio_done",
          session_id: turn.sessionId,
          branch_id: turn.branchId,
          turn_id: turn.turnId,
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
        profile_version: turn.profileVersion || "",
        device_id: turn.deviceId || "",
        source: turn.source,
      });
      await this.recordProviderEvent(turn, providerEvents, "tool_result", {
        tool_name: name,
        tool_call_id: call?.id || "",
        result,
      });
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

  async completeLiveTurn(turn, providerResult) {
    if (this.turn !== turn || turn.completing || turn.status === "completed" || turn.status === "canceled" || turn.status === "error") {
      return;
    }
    turn.completing = true;
    this.responding = true;
    try {
      await closeAudioStream(turn);
      await closeAssistantAudioStream(turn);
      await this.completeTurnWithProviderResult(turn, turn.providerEvents || this.createProviderEvents(turn), providerResult);
    } catch (error) {
      this.failLiveTurn(turn, error);
    } finally {
      this.responding = false;
    }
  }

  async completeTurnWithProviderResult(turn, providerEvents, providerResult) {
    // Merge streaming partials into the final transcript: if the provider result
    // is missing or the "Voice captured." synthetic placeholder but a real
    // transcript_partial/transcript_final arrived over the stream, prefer that so
    // the stored turn holds what was actually heard, not the fallback.
    const resultTranscript = String(providerResult?.transcript || "").trim();
    const streamedTranscript = String(providerEvents.transcript || "").trim();
    const resultIsSynthetic = !resultTranscript || resultTranscript === "Voice captured.";
    const transcript = (resultIsSynthetic && streamedTranscript)
      ? streamedTranscript
      : (resultTranscript || streamedTranscript);
    const assistantText = String(providerResult?.assistant_text || providerEvents.assistantText || "").trim();
    const assistantAudioFormat = providerResult?.audio_format || ASSISTANT_AUDIO_FORMAT;
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
    if (!transcriptSource || (transcriptSource === "synthetic" && streamedTranscript)) {
      transcriptSource = (transcript && transcript !== "Voice captured.") ? "stt" : "synthetic";
    }
    const canonicalRecord = await this.recordCompletedTurn(turn, providerResult, {
      transcript,
      transcriptSource,
      assistantText,
      assistantAudioFormat,
    });
    const profileControlText = profileControlAssistantText(canonicalRecord);
    if (profileControlText) {
      if (String(providerEvents.assistantText || "").trim() !== profileControlText) {
        await providerHooks.onAssistantText(profileControlText);
      }
    } else if (assistantText && !providerEvents.assistantTextSent) {
      await providerHooks.onAssistantText(assistantText);
    }
    if (providerEvents.assistantAudioStarted && !providerEvents.assistantAudioDone) {
      await providerHooks.onAssistantAudioDone();
    }
    await this.recordProviderEvent(turn, providerEvents, "turn_completed", {
      transcript,
      assistant_text: assistantText,
      gateway_assistant_text: profileControlText || "",
    });
    await this.sendEvent({
      type: "turn_done",
      session_id: turn.sessionId,
      branch_id: turn.branchId,
      turn_id: turn.turnId,
      status: "completed",
      transcription_only: providerResult?.transcription_only === true,
    });

    turn.status = "completed";
    writeTurnMetadata(turn, {
      status: "completed",
      completed_at: nowIso(),
    });
    if (this.turn === turn) {
      this.turn = null;
    }
  }

  // Persist an interrupted/canceled/closed live turn into the SAME canonical
  // conversation record path as a completed turn, so whatever transcript or
  // assistant text the provider produced before the cutoff still carries
  // forward to the next turn and to the other device. Without this, an
  // interrupted Gemini Live turn only lands in observability logs and is lost
  // from the Moa-owned context pack.
  async recordIncompleteTurn(turn, status, errorMessage = "") {
    if (!turn || turn.recordedCanonical || !this.onTurnCompleted) {
      return;
    }
    if (turn.status === "completed") {
      return;
    }
    const providerEvents = turn.providerEvents || this.createProviderEvents(turn);
    const transcript = String(providerEvents.transcript || "").trim();
    const assistantText = String(providerEvents.assistantText || "").trim();
    if (!transcript && !assistantText && turn.audioBytes <= 0 && turn.assistantAudioBytes <= 0) {
      return;
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
        started_at: turn.startedAt,
        completed_at: nowIso(),
        transcript: transcript || (turn.audioBytes > 0 ? "Voice captured." : ""),
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
        assistant_audio: {
          pcm_file: path.basename(turn.assistantPcmPath),
          bytes: turn.assistantAudioBytes,
          chunks: turn.assistantAudioChunks,
        },
        playback_policy: turn.playbackPolicy || {},
        incomplete: true,
        status,
        error: errorMessage,
        provider_events: Array.isArray(providerEvents.events) ? providerEvents.events : [],
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
        started_at: turn.startedAt,
        completed_at: nowIso(),
        transcript: completed.transcript,
        transcript_source: completed.transcriptSource || providerResult?.transcript_source || "",
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
        playback_policy: turn.playbackPolicy || {},
        transcription_only: providerResult?.transcription_only === true,
        provider_events: Array.isArray(turn.providerEvents?.events) ? turn.providerEvents.events : [],
      });
    } catch (error) {
      writeTurnMetadata(turn, {
        canonical_record_error: cleanError(error),
      });
      return null;
    }
  }

  async failLiveTurn(turn, error) {
    if (this.turn !== turn || turn.status === "completed" || turn.status === "canceled") {
      return;
    }
    turn.status = "error";
    await closeAudioStream(turn);
    await closeAssistantAudioStream(turn);
    await this.recordProviderEvent(turn, turn.providerEvents || this.createProviderEvents(turn), "turn_error", {
      error: cleanError(error),
    });
    await this.recordIncompleteTurn(turn, "error", cleanError(error));
    writeTurnMetadata(turn, {
      status: "error",
      error: cleanError(error),
    });
    this.sendError(`failed to complete turn: ${cleanError(error)}`);
    this.turn = null;
  }

  async handleCancelTurn(event) {
    const turn = this.currentTurnFor(event.turn_id);
    if (!turn) {
      return;
    }

    turn.status = "canceled";
    await closeAudioStream(turn);
    await closeAssistantAudioStream(turn);
    if (turn.liveSession) {
      turn.liveSession.cancel();
    }
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
    });
    this.turn = null;
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
    if (!this.turn) {
      return;
    }

    const turn = this.turn;
    if (turn.status !== "recording") {
      turn.status = status;
      await closeAudioStream(turn);
      await closeAssistantAudioStream(turn);
      if (turn.liveSession) {
        turn.liveSession.cancel();
      }
      await this.recordProviderEvent(turn, turn.providerEvents || this.createProviderEvents(turn), status === "interrupted" ? "interruption" : "turn_closed", {
        status,
      });
      await this.recordIncompleteTurn(turn, status);
      writeTurnMetadata(turn, {
        status,
        closed_at: nowIso(),
      });
      this.turn = null;
      return;
    }

    turn.status = status;
    await closeAudioStream(turn);
    await closeAssistantAudioStream(turn);
    if (turn.liveSession) {
      turn.liveSession.cancel();
    }
    await this.recordProviderEvent(turn, turn.providerEvents || this.createProviderEvents(turn), status === "interrupted" ? "interruption" : "turn_closed", {
      status,
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
  return next;
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
    return;
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
}

async function closeAssistantAudioStream(turn) {
  if (!turn.assistantAudioStream) {
    return;
  }

  const stream = turn.assistantAudioStream;
  turn.assistantAudioStream = null;
  await new Promise((resolve, reject) => {
    stream.once("error", reject);
    stream.end(resolve);
  });
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
    source: turn.source,
    input_format: turn.format,
    playback_policy: turn.playbackPolicy || previous.playback_policy || {},
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

function cleanError(error) {
  return String(error?.message || error || "unknown error").replace(/[\r\n]+/g, " ").slice(0, 500);
}

function nowIso() {
  return new Date().toISOString();
}

module.exports = {
  VOICE_SESSION_ENDPOINT,
  createVoiceSessionServer,
  generatePcm16Tone: generateProviderTone,
};
