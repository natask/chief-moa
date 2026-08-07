using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace Aggie.Windows;

public enum DictationPhase
{
    Idle,
    Connecting,
    Listening,
    Pausing,
    Paused,
    Resuming,
    Finalizing,
    Completed,
    Canceling,
    Canceled,
    Failed,
}

public sealed record VoiceDraftPointer(
    [property: JsonPropertyName("draft_id")] string DraftId,
    [property: JsonPropertyName("revision")] long Revision,
    [property: JsonPropertyName("session_id")] string SessionId,
    [property: JsonPropertyName("branch_id")] string BranchId,
    [property: JsonPropertyName("turn_id")] string TurnId,
    [property: JsonPropertyName("state")] string State
);

public enum DictationServerEventKind
{
    TranscriptPartial,
    TranscriptFinal,
    TranscriptFinalized,
    TurnDone,
    Failure,
    Ignored,
}

public sealed record DictationServerEvent(
    DictationServerEventKind Kind,
    string Text = "",
    string Status = "",
    string Reason = ""
);

/// <summary>
/// Pure, provider-neutral Windows projection of the gateway voice-draft
/// protocol. This type performs no microphone, network, clipboard, or model
/// work. The native adapters execute only JSON produced or accepted here.
/// </summary>
public static partial class DictationProtocol
{
    public const string DraftVersion = "voice_drafts_v1";
    public const string StateMachineRevision = "voice_draft_state.v1";
    public const int MaximumEventBytes = 64 * 1024;
    public const int MaximumTranscriptBytes = 32 * 1024;
    public const int MaximumAudioFrameBytes = 64 * 1024;
    private const string BranchId = "default";

    [GeneratedRegex("^[A-Za-z0-9._:-]{1,120}$", RegexOptions.CultureInvariant)]
    private static partial Regex AuthorityToken();

    public static string CreateSessionStart(string sessionId, string turnId)
    {
        RequireToken(sessionId, nameof(sessionId));
        RequireToken(turnId, nameof(turnId));
        var start = new Dictionary<string, object?>
        {
            ["type"] = "session_start",
            ["source"] = "moa-windows-dictation",
            ["session_id"] = sessionId,
            ["conversation_id"] = sessionId,
            ["branch_id"] = BranchId,
            ["turn_id"] = turnId,
            ["delivery_intent"] = "literal_dictation",
            ["transcription_only"] = true,
            ["client"] = new Dictionary<string, string>
            {
                ["platform"] = "windows",
                ["source"] = "moa-windows-dictation",
                ["input"] = "voice",
            },
            ["playback_policy"] = new Dictionary<string, bool>
            {
                ["assistant_overlap"] = false,
            },
            ["format"] = new Dictionary<string, object>
            {
                ["encoding"] = "pcm16",
                ["sample_rate"] = 16_000,
                ["channels"] = 1,
            },
            ["voice_draft"] = new Dictionary<string, object>
            {
                ["version"] = DraftVersion,
                ["operation"] = "create",
                ["idempotency_key"] = $"windows:{turnId}:create:1",
                ["surface"] = "windows",
            },
        };
        return BoundedJson(start);
    }

    public static VoiceDraftPointer ParseReady(string json, string sessionId, string turnId)
    {
        using var document = Parse(json);
        var root = document.RootElement;
        RequireString(root, "type", "session_ready");
        RequireAuthority(root, sessionId, BranchId, turnId);
        RequireCapability(root);
        var draft = RequireObject(root, "voice_draft");
        var pointer = new VoiceDraftPointer(
            RequiredToken(draft, "draft_id"),
            PositiveRevision(draft, "revision"),
            sessionId,
            BranchId,
            turnId,
            RequiredString(draft, "state")
        );
        if (pointer.State != "capturing" || RequiredString(draft, "action") != "session_start")
            throw ProtocolError("Gateway returned mismatched voice-draft start authority.");
        return pointer;
    }

    public static VoiceDraftPointer ParseState(string json, VoiceDraftPointer current, string expectedAction)
    {
        RequirePointer(current);
        if (!ControlStates().TryGetValue(expectedAction, out var expectedStates))
            throw ProtocolError("Unsupported voice-draft control.");
        using var document = Parse(json);
        var root = document.RootElement;
        RequireString(root, "type", "voice_draft_state");
        RequireAuthority(root, current.SessionId, current.BranchId, current.TurnId);
        RequireCapability(root);
        var draft = RequireObject(root, "voice_draft");
        var next = new VoiceDraftPointer(
            RequiredToken(draft, "draft_id"),
            PositiveRevision(draft, "revision"),
            current.SessionId,
            current.BranchId,
            current.TurnId,
            RequiredString(draft, "state")
        );
        if (next.DraftId != current.DraftId || next.Revision <= current.Revision)
            throw ProtocolError("Gateway returned stale or mismatched voice-draft authority.");
        if (RequiredString(draft, "action") != expectedAction || !expectedStates.Contains(next.State))
            throw ProtocolError("Gateway returned an unexpected voice-draft transition.");
        return next;
    }

    public static void ValidateCommittedReady(string json, VoiceDraftPointer current)
    {
        RequirePointer(current);
        if (current.State is not ("send_ready" or "sent"))
            throw ProtocolError("Dictation handoff arrived before explicit send.");
        using var document = Parse(json);
        var root = document.RootElement;
        RequireString(root, "type", "session_ready");
        RequireAuthority(root, current.SessionId, current.BranchId, current.TurnId);
        if (root.TryGetProperty("voice_draft", out _))
            throw ProtocolError("Dictation handoff unexpectedly replaced draft authority.");
        var transcriptFinalize = RequireObject(root, "transcript_finalize");
        if (!transcriptFinalize.TryGetProperty("supported", out var supported) || supported.ValueKind != JsonValueKind.True)
            throw ProtocolError("Gateway does not support transcription-only finalization.");
    }

    public static string CreateControl(string action, VoiceDraftPointer pointer)
    {
        RequirePointer(pointer);
        if (!new[] { "pause", "resume", "park", "discard" }.Contains(action))
            throw ProtocolError("Unsupported voice-draft control.");
        return BoundedJson(new Dictionary<string, object>
        {
            ["type"] = "voice_draft_control",
            ["session_id"] = pointer.SessionId,
            ["branch_id"] = pointer.BranchId,
            ["turn_id"] = pointer.TurnId,
            ["draft_id"] = pointer.DraftId,
            ["expected_revision"] = pointer.Revision,
            ["action"] = action,
            ["idempotency_key"] = $"windows:{pointer.TurnId}:{action}:{pointer.Revision}",
        });
    }

    public static string CreateCommit(VoiceDraftPointer pointer)
    {
        RequirePointer(pointer);
        return BoundedJson(new Dictionary<string, object>
        {
            ["type"] = "commit_turn",
            ["session_id"] = pointer.SessionId,
            ["branch_id"] = pointer.BranchId,
            ["turn_id"] = pointer.TurnId,
            ["draft_id"] = pointer.DraftId,
            ["expected_revision"] = pointer.Revision,
            ["idempotency_key"] = $"windows:{pointer.TurnId}:send:{pointer.Revision}",
        });
    }

    public static DictationServerEvent ParseServerEvent(string json)
    {
        using var document = Parse(json);
        var root = document.RootElement;
        var type = RequiredString(root, "type");
        return type switch
        {
            "transcript_partial" => new(DictationServerEventKind.TranscriptPartial, Transcript(root, "text")),
            "transcript_final" => new(DictationServerEventKind.TranscriptFinal, Transcript(root, "text")),
            "transcript_finalized" => new(
                DictationServerEventKind.TranscriptFinalized,
                Transcript(root, "transcript"),
                RequiredString(root, "status"),
                OptionalString(root, "reason")
            ),
            "turn_done" => new(
                DictationServerEventKind.TurnDone,
                "",
                RequiredString(root, "status"),
                OptionalString(root, "reason")
            ),
            "error" => new(DictationServerEventKind.Failure, Message(root)),
            "assistant_text" or "assistant_text_delta" or "assistant_audio_start" or "assistant_audio_done"
                => throw ProtocolError("Assistant output is invalid on literal dictation."),
            "session_ready" or "voice_draft_state" => new(DictationServerEventKind.Ignored),
            _ => new(DictationServerEventKind.Ignored),
        };
    }

    public static string SerializePointer(VoiceDraftPointer pointer)
    {
        RequirePointer(pointer);
        return BoundedJson(pointer);
    }

    public static VoiceDraftPointer ParsePointer(string json)
    {
        using var document = Parse(json);
        var root = document.RootElement;
        var pointer = new VoiceDraftPointer(
            RequiredToken(root, "draft_id"),
            PositiveRevision(root, "revision"),
            RequiredToken(root, "session_id"),
            RequiredToken(root, "branch_id"),
            RequiredToken(root, "turn_id"),
            RequiredString(root, "state")
        );
        RequirePointer(pointer);
        return pointer;
    }

    private static IReadOnlyDictionary<string, HashSet<string>> ControlStates() =>
        new Dictionary<string, HashSet<string>>
        {
            ["pause"] = new(["paused"]),
            ["resume"] = new(["capturing"]),
            ["park"] = new(["parked"]),
            ["discard"] = new(["discarded"]),
            ["send"] = new(["send_ready", "sent"]),
        };

    private static JsonDocument Parse(string json)
    {
        if (string.IsNullOrWhiteSpace(json) || Encoding.UTF8.GetByteCount(json) > MaximumEventBytes)
            throw ProtocolError("Gateway event was empty or oversized.");
        try
        {
            var document = JsonDocument.Parse(json, new JsonDocumentOptions { MaxDepth = 12 });
            if (document.RootElement.ValueKind != JsonValueKind.Object)
            {
                document.Dispose();
                throw ProtocolError("Gateway event was malformed.");
            }
            return document;
        }
        catch (JsonException)
        {
            throw ProtocolError("Gateway event was malformed.");
        }
    }

    private static void RequireCapability(JsonElement root)
    {
        var capabilities = RequireObject(root, "capabilities");
        var capability = RequireObject(capabilities, DraftVersion);
        if (!capability.TryGetProperty("supported", out var supported) || supported.ValueKind != JsonValueKind.True
            || RequiredString(capability, "revision") != DraftVersion
            || RequiredString(capability, "state_machine_revision") != StateMachineRevision)
            throw ProtocolError("Gateway voice-draft capability did not match this client.");
    }

    private static void RequireAuthority(JsonElement root, string sessionId, string branchId, string turnId)
    {
        if (RequiredToken(root, "session_id") != sessionId
            || RequiredToken(root, "branch_id") != branchId
            || RequiredToken(root, "turn_id") != turnId)
            throw ProtocolError("Gateway event did not match this dictation turn.");
    }

    private static void RequirePointer(VoiceDraftPointer pointer)
    {
        RequireToken(pointer.DraftId, nameof(pointer.DraftId));
        RequireToken(pointer.SessionId, nameof(pointer.SessionId));
        RequireToken(pointer.BranchId, nameof(pointer.BranchId));
        RequireToken(pointer.TurnId, nameof(pointer.TurnId));
        if (pointer.Revision <= 0 || pointer.State is not ("capturing" or "paused" or "parked" or "send_ready" or "sent" or "discarded"))
            throw ProtocolError("Voice-draft pointer was malformed.");
    }

    private static JsonElement RequireObject(JsonElement root, string key)
    {
        if (!root.TryGetProperty(key, out var value) || value.ValueKind != JsonValueKind.Object)
            throw ProtocolError($"Gateway event omitted {key}.");
        return value;
    }

    private static string RequiredString(JsonElement root, string key)
    {
        if (!root.TryGetProperty(key, out var value) || value.ValueKind != JsonValueKind.String)
            throw ProtocolError($"Gateway event omitted {key}.");
        var text = value.GetString() ?? "";
        if (string.IsNullOrEmpty(text) || text.Length > 512 || text.Any(char.IsControl))
            throw ProtocolError($"Gateway event contained invalid {key}.");
        return text;
    }

    private static string RequiredContentString(JsonElement root, string key)
    {
        if (!root.TryGetProperty(key, out var value) || value.ValueKind != JsonValueKind.String)
            throw ProtocolError($"Gateway event omitted {key}.");
        return value.GetString() ?? "";
    }

    private static string OptionalString(JsonElement root, string key)
    {
        if (!root.TryGetProperty(key, out var value) || value.ValueKind == JsonValueKind.Null) return "";
        return value.ValueKind == JsonValueKind.String && (value.GetString()?.Length ?? 0) <= 512
            ? value.GetString() ?? ""
            : throw ProtocolError($"Gateway event contained invalid {key}.");
    }

    private static void RequireString(JsonElement root, string key, string expected)
    {
        if (RequiredString(root, key) != expected) throw ProtocolError($"Gateway event was not {expected}.");
    }

    private static string RequiredToken(JsonElement root, string key)
    {
        var value = RequiredString(root, key);
        RequireToken(value, key);
        return value;
    }

    private static long PositiveRevision(JsonElement root, string key)
    {
        if (!root.TryGetProperty(key, out var value) || !value.TryGetInt64(out var revision) || revision <= 0)
            throw ProtocolError($"Gateway event contained invalid {key}.");
        return revision;
    }

    private static string Transcript(JsonElement root, string key)
    {
        var text = RequiredContentString(root, key).Trim();
        if (string.IsNullOrEmpty(text) || Encoding.UTF8.GetByteCount(text) > MaximumTranscriptBytes)
            throw ProtocolError("Gateway transcript was empty or oversized.");
        return text;
    }

    private static string Message(JsonElement root)
    {
        var message = RequiredContentString(root, "message").Trim();
        if (string.IsNullOrEmpty(message)) throw ProtocolError("Gateway error was empty.");
        if (Encoding.UTF8.GetByteCount(message) > MaximumTranscriptBytes)
            throw ProtocolError("Gateway error was oversized.");
        return message;
    }

    private static string BoundedJson<T>(T value)
    {
        var json = JsonSerializer.Serialize(value);
        if (Encoding.UTF8.GetByteCount(json) > MaximumEventBytes)
            throw ProtocolError("Client event was oversized.");
        return json;
    }

    private static void RequireToken(string value, string name)
    {
        if (!AuthorityToken().IsMatch(value)) throw new ArgumentException("Authority token was malformed.", name);
    }

    private static InvalidDataException ProtocolError(string message) => new(message);
}
