using System.Text.Json;
using Aggie.Windows;
using Xunit;

namespace Aggie.Windows.Tests;

public sealed class DictationControllerTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), $"ag-windows-tests-{Guid.NewGuid():N}");

    [Fact]
    public async Task ExplicitCapturePausesResumesAndFinalizesOneDurableDraft()
    {
        var transport = new FakeTransport();
        var microphone = new FakeMicrophone();
        await using var controller = new DictationController(() => transport, microphone, new DraftPointerStore(root));

        await controller.StartAsync(new Uri("https://gateway.example"), "session-credential");
        Assert.Equal(DictationPhase.Listening, controller.Phase);
        Assert.Equal(1, microphone.Starts);
        Assert.NotNull(controller.RetainedPointer);

        microphone.Emit([1, 0, 2, 0]);
        await controller.PauseAsync();
        Assert.Equal(DictationPhase.Paused, controller.Phase);
        Assert.Equal(1, microphone.Stops);
        Assert.Contains(transport.Events, value => value.Contains("\"action\":\"pause\""));

        await controller.ResumeAsync();
        Assert.Equal(DictationPhase.Listening, controller.Phase);
        Assert.Equal(2, microphone.Starts);
        Assert.Equal("draft-one", controller.RetainedPointer?.DraftId);

        await controller.FinishAsync();
        Assert.Equal(DictationPhase.Completed, controller.Phase);
        Assert.Equal("literal windows words", controller.Snapshot.Transcript);
        Assert.Null(controller.RetainedPointer);
        Assert.Contains(transport.Events, value => value.Contains("\"type\":\"commit_turn\""));
        Assert.DoesNotContain(transport.Events, value => value.Contains("assistant_text", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(transport.Events, value => value.Contains("assistant_audio", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task CancelDiscardsWithoutCommitOrTranscript()
    {
        var transport = new FakeTransport();
        var microphone = new FakeMicrophone();
        await using var controller = new DictationController(() => transport, microphone, new DraftPointerStore(root));
        await controller.StartAsync(new Uri("https://gateway.example"), "session-credential");
        await controller.CancelAsync();
        Assert.Equal(DictationPhase.Canceled, controller.Phase);
        Assert.Null(controller.RetainedPointer);
        Assert.Contains(transport.Events, value => value.Contains("\"action\":\"discard\""));
        Assert.DoesNotContain(transport.Events, value => value.Contains("commit_turn"));
        Assert.Empty(controller.Snapshot.Transcript);
    }

    [Fact]
    public async Task RetainedPointerBlocksSilentReplacement()
    {
        var store = new DraftPointerStore(root);
        store.Save(new VoiceDraftPointer("retained-one", 7, "session-one", "default", "turn-one", "parked"));
        var transport = new FakeTransport();
        await using var controller = new DictationController(() => transport, new FakeMicrophone(), store);
        await controller.StartAsync(new Uri("https://gateway.example"), "session-credential");
        Assert.Equal(DictationPhase.Failed, controller.Phase);
        Assert.Equal("retained-one", controller.RetainedPointer?.DraftId);
        Assert.False(transport.Connected);
    }

    public void Dispose()
    {
        if (Directory.Exists(root)) Directory.Delete(root, true);
    }

    private sealed class FakeMicrophone : IPcm16MicrophoneCapture
    {
        private Action<ReadOnlyMemory<byte>>? handler;
        public bool IsActive { get; private set; }
        public int Starts { get; private set; }
        public int Stops { get; private set; }
        public void Start(Action<ReadOnlyMemory<byte>> frameHandler, Action<string> failureHandler)
        {
            handler = frameHandler;
            Starts += 1;
            IsActive = true;
        }
        public void Stop()
        {
            if (!IsActive) return;
            Stops += 1;
            IsActive = false;
        }
        public void Emit(byte[] bytes) => handler?.Invoke(bytes);
        public void Dispose() => Stop();
    }

    private sealed class FakeTransport : IVoiceDraftTransport
    {
        private Func<string, Task>? handler;
        private string session = "";
        private string turn = "";
        private long revision = 1;
        public bool Connected { get; private set; }
        public List<string> Events { get; } = [];

        public async Task ConnectAsync(Uri gatewayOrigin, string bearerToken, string sessionStart,
            Func<string, Task> eventHandler, Func<string, Task> failureHandler, CancellationToken cancellationToken)
        {
            Connected = true;
            handler = eventHandler;
            using var start = JsonDocument.Parse(sessionStart);
            session = start.RootElement.GetProperty("session_id").GetString() ?? "";
            turn = start.RootElement.GetProperty("turn_id").GetString() ?? "";
            Events.Add(sessionStart);
            await eventHandler(Ready());
        }

        public Task SendAudioAsync(ReadOnlyMemory<byte> pcm16, CancellationToken cancellationToken) => Task.CompletedTask;

        public async Task SendEventAsync(string json, CancellationToken cancellationToken)
        {
            Events.Add(json);
            using var request = JsonDocument.Parse(json);
            var root = request.RootElement;
            if (root.GetProperty("type").GetString() == "voice_draft_control")
            {
                var action = root.GetProperty("action").GetString() ?? "";
                var state = action switch { "pause" => "paused", "resume" => "capturing", "discard" => "discarded", _ => "invalid" };
                await RequireHandler()(State(++revision, state, action));
            }
            else
            {
                await RequireHandler()(State(++revision, "send_ready", "send"));
                await RequireHandler()(CommittedReady());
                await RequireHandler()(State(++revision, "sent", "send"));
                await RequireHandler()("{\"type\":\"transcript_finalized\",\"status\":\"completed\",\"transcript\":\"literal windows words\",\"transcription_only\":true}");
            }
        }

        public Task CloseAsync() { Connected = false; return Task.CompletedTask; }
        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
        private Func<string, Task> RequireHandler() => handler ?? throw new InvalidOperationException();
        private string Ready() => Envelope("session_ready", 1, "capturing", "session_start", includeCapability: true);
        private string State(long value, string state, string action) => Envelope("voice_draft_state", value, state, action, includeCapability: true);
        private string CommittedReady() => JsonSerializer.Serialize(new { type = "session_ready", session_id = session, branch_id = "default", turn_id = turn, transcript_finalize = new { supported = true } });
        private string Envelope(string type, long value, string state, string action, bool includeCapability) => JsonSerializer.Serialize(new
        {
            type,
            session_id = session,
            branch_id = "default",
            turn_id = turn,
            capabilities = new { voice_drafts_v1 = new { supported = includeCapability, revision = "voice_drafts_v1", state_machine_revision = "voice_draft_state.v1" } },
            voice_draft = new { draft_id = "draft-one", revision = value, state, action },
        });
    }
}
