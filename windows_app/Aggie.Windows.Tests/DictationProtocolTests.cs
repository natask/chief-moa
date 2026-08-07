using System.Text;
using System.Text.Json;
using Aggie.Windows;
using Xunit;

namespace Aggie.Windows.Tests;

public sealed class DictationProtocolTests
{
    private const string Session = "windows-session";
    private const string Turn = "turn-one";

    [Fact]
    public void StartIsLiteralDraftCaptureOnly()
    {
        using var document = JsonDocument.Parse(DictationProtocol.CreateSessionStart(Session, Turn));
        var root = document.RootElement;
        Assert.Equal("session_start", root.GetProperty("type").GetString());
        Assert.Equal("moa-windows-dictation", root.GetProperty("source").GetString());
        Assert.Equal("literal_dictation", root.GetProperty("delivery_intent").GetString());
        Assert.True(root.GetProperty("transcription_only").GetBoolean());
        Assert.Equal("windows", root.GetProperty("client").GetProperty("platform").GetString());
        Assert.Equal("pcm16", root.GetProperty("format").GetProperty("encoding").GetString());
        Assert.Equal(16_000, root.GetProperty("format").GetProperty("sample_rate").GetInt32());
        Assert.Equal(DictationProtocol.DraftVersion, root.GetProperty("voice_draft").GetProperty("version").GetString());
        Assert.Equal("create", root.GetProperty("voice_draft").GetProperty("operation").GetString());
        Assert.False(root.TryGetProperty("assistant", out _));
        Assert.False(root.TryGetProperty("screen", out _));
        Assert.False(root.TryGetProperty("context", out _));
    }

    [Fact]
    public void ReadyBindsExactCapabilityAndTurnAuthority()
    {
        var pointer = DictationProtocol.ParseReady(Ready(), Session, Turn);
        Assert.Equal("draft-one", pointer.DraftId);
        Assert.Equal(1, pointer.Revision);
        Assert.Equal("capturing", pointer.State);
        Assert.Throws<InvalidDataException>(() => DictationProtocol.ParseReady(Ready(session: "other"), Session, Turn));
        Assert.Throws<InvalidDataException>(() => DictationProtocol.ParseReady(Ready(machine: "voice_draft_state.v2"), Session, Turn));
        Assert.Throws<InvalidDataException>(() => DictationProtocol.ParseReady(Ready(action: "resume"), Session, Turn));
    }

    [Fact]
    public void PauseResumeAndSendRequireMonotonicSameDraftAuthority()
    {
        var ready = DictationProtocol.ParseReady(Ready(), Session, Turn);
        var pauseJson = DictationProtocol.CreateControl("pause", ready);
        Assert.Contains("\"expected_revision\":1", pauseJson);
        var paused = DictationProtocol.ParseState(State(2, "paused", "pause"), ready, "pause");
        var resumed = DictationProtocol.ParseState(State(3, "capturing", "resume"), paused, "resume");
        var sendReady = DictationProtocol.ParseState(State(4, "send_ready", "send"), resumed, "send");
        DictationProtocol.ValidateCommittedReady(CommittedReady(), sendReady);
        var sent = DictationProtocol.ParseState(State(5, "sent", "send"), sendReady, "send");
        Assert.Equal(5, sent.Revision);
        Assert.Throws<InvalidDataException>(() => DictationProtocol.ParseState(State(3, "paused", "pause"), resumed, "pause"));
        Assert.Throws<InvalidDataException>(() => DictationProtocol.ParseState(State(4, "paused", "pause", draft: "other"), resumed, "pause"));
    }

    [Fact]
    public void CancelAndCommitAreExactAndNeverAssistantCommands()
    {
        var ready = DictationProtocol.ParseReady(Ready(), Session, Turn);
        using var cancel = JsonDocument.Parse(DictationProtocol.CreateControl("discard", ready));
        Assert.Equal("voice_draft_control", cancel.RootElement.GetProperty("type").GetString());
        Assert.Equal("discard", cancel.RootElement.GetProperty("action").GetString());
        using var commit = JsonDocument.Parse(DictationProtocol.CreateCommit(ready));
        Assert.Equal("commit_turn", commit.RootElement.GetProperty("type").GetString());
        Assert.Equal("draft-one", commit.RootElement.GetProperty("draft_id").GetString());
        Assert.False(commit.RootElement.TryGetProperty("assistant", out _));
        Assert.Throws<InvalidDataException>(() => DictationProtocol.ParseServerEvent("{\"type\":\"assistant_text\",\"text\":\"no\"}"));
        Assert.Throws<InvalidDataException>(() => DictationProtocol.ParseServerEvent("{\"type\":\"assistant_audio_start\"}"));
    }

    [Fact]
    public void PointerPersistenceContainsIdentityOnlyAndFailsClosed()
    {
        var pointer = DictationProtocol.ParseReady(Ready(), Session, Turn);
        var persisted = DictationProtocol.SerializePointer(pointer);
        Assert.Equal(pointer, DictationProtocol.ParsePointer(persisted));
        Assert.DoesNotContain("transcript", persisted, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("token", persisted, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("audio", persisted, StringComparison.OrdinalIgnoreCase);
        Assert.ThrowsAny<Exception>(() => DictationProtocol.ParsePointer(persisted.Replace("draft-one", "../draft")));
    }

    [Fact]
    public void LiteralEventsAreBoundedAndTyped()
    {
        Assert.Equal("draft words", DictationProtocol.ParseServerEvent("{\"type\":\"transcript_partial\",\"text\":\" draft words \"}").Text);
        Assert.Equal("exact final", DictationProtocol.ParseServerEvent("{\"type\":\"transcript_final\",\"text\":\"exact final\"}").Text);
        var completed = DictationProtocol.ParseServerEvent("{\"type\":\"transcript_finalized\",\"status\":\"completed\",\"transcript\":\"kept words\"}");
        Assert.Equal(DictationServerEventKind.TranscriptFinalized, completed.Kind);
        Assert.Equal("kept words", completed.Text);
        var longValid = new string('a', 4_096);
        Assert.Equal(longValid, DictationProtocol.ParseServerEvent(JsonSerializer.Serialize(new { type = "transcript_final", text = longValid })).Text);
        var oversized = "{\"type\":\"ignored\",\"pad\":\"" + new string('a', DictationProtocol.MaximumEventBytes) + "\"}";
        Assert.True(Encoding.UTF8.GetByteCount(oversized) > DictationProtocol.MaximumEventBytes);
        Assert.Throws<InvalidDataException>(() => DictationProtocol.ParseServerEvent(oversized));
    }

    private static string Ready(string session = Session, string action = "session_start", string machine = "voice_draft_state.v1") => JsonSerializer.Serialize(new
    {
        type = "session_ready",
        session_id = session,
        branch_id = "default",
        turn_id = Turn,
        capabilities = new { voice_drafts_v1 = new { supported = true, revision = "voice_drafts_v1", state_machine_revision = machine } },
        voice_draft = new { draft_id = "draft-one", revision = 1, state = "capturing", action },
    });

    private static string State(long revision, string state, string action, string draft = "draft-one") => JsonSerializer.Serialize(new
    {
        type = "voice_draft_state",
        session_id = Session,
        branch_id = "default",
        turn_id = Turn,
        capabilities = new { voice_drafts_v1 = new { supported = true, revision = "voice_drafts_v1", state_machine_revision = "voice_draft_state.v1" } },
        voice_draft = new { draft_id = draft, revision, state, action },
    });

    private static string CommittedReady() => JsonSerializer.Serialize(new
    {
        type = "session_ready",
        session_id = Session,
        branch_id = "default",
        turn_id = Turn,
        transcript_finalize = new { supported = true },
    });
}
