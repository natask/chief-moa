using System.Text.Json;
using System.Threading.Channels;

namespace Aggie.Windows;

public sealed record DictationSnapshot(
    DictationPhase Phase,
    string Status,
    string Transcript,
    string DraftIdentity,
    bool CanStart,
    bool CanFinish,
    bool CanPause,
    bool CanResume,
    bool CanCancel,
    bool CanCopy
);

public sealed class DictationController : IAsyncDisposable
{
    private readonly Func<IVoiceDraftTransport> transportFactory;
    private readonly IPcm16MicrophoneCapture microphone;
    private readonly DraftPointerStore pointerStore;
    private readonly SemaphoreSlim commandGate = new(1, 1);
    private readonly CancellationTokenSource lifetime = new();
    private IVoiceDraftTransport? transport;
    private Channel<byte[]>? audioFrames;
    private Task? audioPump;
    private TaskCompletionSource<VoiceDraftPointer>? ready;
    private TaskCompletionSource<VoiceDraftPointer>? controlAck;
    private TaskCompletionSource? audioDrained;
    private VoiceDraftPointer? pointer;
    private string pendingAction = "";
    private string transcript = "";
    private string status = "Ready for literal dictation.";
    private long pendingAudio;
    private string currentSessionId = "";
    private string currentTurnId = "";
    private int finalizationGeneration;

    public event Action<DictationSnapshot>? StateChanged;
    public DictationPhase Phase { get; private set; } = DictationPhase.Idle;
    public VoiceDraftPointer? RetainedPointer => pointerStore.Load();
    public DictationSnapshot Snapshot => BuildSnapshot();

    public DictationController(
        Func<IVoiceDraftTransport>? transportFactory = null,
        IPcm16MicrophoneCapture? microphone = null,
        DraftPointerStore? pointerStore = null
    )
    {
        this.transportFactory = transportFactory ?? (() => new GatewayVoiceDraftTransport());
        this.microphone = microphone ?? new Pcm16MicrophoneCapture();
        this.pointerStore = pointerStore ?? new DraftPointerStore();
        Publish();
    }

    public async Task StartAsync(Uri gatewayOrigin, string bearerToken)
    {
        await commandGate.WaitAsync(lifetime.Token);
        try
        {
            if (Phase is not (DictationPhase.Idle or DictationPhase.Completed or DictationPhase.Canceled or DictationPhase.Failed)) return;
            var retained = pointerStore.Load();
            if (pointerStore.Exists)
            {
                pointer = retained;
                Fail(retained is null
                    ? "A retained draft pointer is unreadable. This candidate will not overwrite it."
                    : "A retained gateway draft already exists. Its identity is preserved; this candidate will not overwrite it.");
                return;
            }
            transcript = "";
            pendingAction = "";
            pointer = null;
            currentSessionId = $"windows-{Guid.NewGuid():N}";
            currentTurnId = $"turn-{Guid.NewGuid():N}";
            var start = DictationProtocol.CreateSessionStart(currentSessionId, currentTurnId);
            transport = transportFactory();
            ready = new(TaskCreationOptions.RunContinuationsAsynchronously);
            StartAudioPump();
            SetPhase(DictationPhase.Connecting, "Connecting to the gateway before opening the microphone…");
            await transport.ConnectAsync(
                gatewayOrigin,
                bearerToken,
                start,
                HandleGatewayEventAsync,
                FailAsync,
                lifetime.Token
            );
            var accepted = await ready.Task.WaitAsync(TimeSpan.FromSeconds(20), lifetime.Token);
            pointer = accepted;
            StartMicrophone();
            SetPhase(DictationPhase.Listening, "Listening for literal dictation. No assistant request will run.");
        }
        catch (TimeoutException)
        {
            await FailAsync("Gateway did not acknowledge a durable voice draft.");
        }
        catch (Exception error)
        {
            await FailAsync(BoundedFailure(error, "Dictation could not start."));
        }
        finally
        {
            commandGate.Release();
        }
    }

    public async Task PauseAsync()
    {
        await commandGate.WaitAsync(lifetime.Token);
        try
        {
            if (Phase != DictationPhase.Listening || pointer is null) return;
            microphone.Stop();
            await DrainAudioAsync();
            await SendControlAsync("pause", DictationPhase.Pausing, "Pausing this durable draft…");
        }
        catch (Exception error) { await FailAsync(BoundedFailure(error, "Dictation could not pause.")); }
        finally { commandGate.Release(); }
    }

    public async Task ResumeAsync()
    {
        await commandGate.WaitAsync(lifetime.Token);
        try
        {
            if (Phase != DictationPhase.Paused || pointer is null) return;
            await SendControlAsync("resume", DictationPhase.Resuming, "Resuming this same durable draft…");
        }
        catch (Exception error) { await FailAsync(BoundedFailure(error, "Dictation could not resume.")); }
        finally { commandGate.Release(); }
    }

    public async Task FinishAsync()
    {
        await commandGate.WaitAsync(lifetime.Token);
        try
        {
            if (Phase is not (DictationPhase.Listening or DictationPhase.Paused) || pointer is null) return;
            microphone.Stop();
            await DrainAudioAsync();
            pendingAction = "send";
            SetPhase(DictationPhase.Finalizing, "Finalizing the literal transcript…");
            await RequireTransport().SendEventAsync(DictationProtocol.CreateCommit(pointer), lifetime.Token);
            var generation = ++finalizationGeneration;
            _ = MonitorFinalizationAsync(generation);
        }
        catch (Exception error) { await FailAsync(BoundedFailure(error, "Dictation could not finish.")); }
        finally { commandGate.Release(); }
    }

    public async Task CancelAsync()
    {
        await commandGate.WaitAsync(lifetime.Token);
        try
        {
            if (Phase is not (DictationPhase.Listening or DictationPhase.Paused)
                || pointer is null) return;
            microphone.Stop();
            await DrainAudioAsync();
            await SendControlAsync("discard", DictationPhase.Canceling, "Discarding this capture without transcription…");
        }
        catch (Exception error) { await FailAsync(BoundedFailure(error, "Dictation could not cancel safely.")); }
        finally { commandGate.Release(); }
    }

    public async ValueTask DisposeAsync()
    {
        microphone.Stop();
        audioFrames?.Writer.TryComplete();
        lifetime.Cancel();
        if (transport is not null) await transport.DisposeAsync();
        microphone.Dispose();
        commandGate.Dispose();
        lifetime.Dispose();
    }

    private async Task HandleGatewayEventAsync(string json)
    {
        try
        {
            using var document = JsonDocument.Parse(json);
            var root = document.RootElement;
            var type = root.TryGetProperty("type", out var rawType) ? rawType.GetString() ?? "" : "";
            if (type == "session_ready")
            {
                var session = ready ?? throw new InvalidDataException("Unexpected draft acknowledgement.");
                if (!session.Task.IsCompleted)
                {
                    var expectedStart = DictationProtocol.ParseReady(json, currentSessionId, currentTurnId);
                    pointer = expectedStart;
                    pointerStore.Save(expectedStart);
                    session.TrySetResult(expectedStart);
                    Publish();
                }
                else
                {
                    DictationProtocol.ValidateCommittedReady(json, pointer
                        ?? throw new InvalidDataException("Dictation handoff lost its draft authority."));
                }
                return;
            }
            if (type == "voice_draft_state")
            {
                var current = pointer ?? throw new InvalidDataException("Gateway sent an unbound draft transition.");
                var action = pendingAction;
                if (string.IsNullOrEmpty(action)) throw new InvalidDataException("Gateway sent an unsolicited draft transition.");
                pointer = DictationProtocol.ParseState(json, current, action);
                pointerStore.Save(pointer);
                controlAck?.TrySetResult(pointer);
                if (action == "pause")
                {
                    pendingAction = "";
                    SetPhase(DictationPhase.Paused, "Paused. The microphone is closed and the draft remains durable.");
                }
                else if (action == "resume")
                {
                    pendingAction = "";
                    StartMicrophone();
                    SetPhase(DictationPhase.Listening, "Listening again on the same durable draft.");
                }
                else if (action == "discard")
                {
                    pendingAction = "";
                    pointerStore.Clear();
                    pointer = null;
                    audioFrames?.Writer.TryComplete();
                    SetPhase(DictationPhase.Canceled, "Canceled. No transcript or assistant work was requested.");
                    await CloseTransportAsync();
                }
                else if (action == "send" && pointer.State == "sent")
                {
                    pointerStore.Clear();
                    Publish();
                }
                else Publish();
                return;
            }

            var serverEvent = DictationProtocol.ParseServerEvent(json);
            switch (serverEvent.Kind)
            {
                case DictationServerEventKind.TranscriptPartial:
                case DictationServerEventKind.TranscriptFinal:
                    transcript = serverEvent.Text;
                    Publish();
                    break;
                case DictationServerEventKind.TranscriptFinalized:
                    if (!serverEvent.Status.Equals("completed", StringComparison.OrdinalIgnoreCase))
                        throw new InvalidDataException(serverEvent.Reason.Length > 0 ? serverEvent.Reason : "Transcription did not complete.");
                    transcript = serverEvent.Text;
                    pendingAction = "";
                    finalizationGeneration += 1;
                    audioFrames?.Writer.TryComplete();
                    SetPhase(DictationPhase.Completed, "Literal transcript ready. Edit or copy it locally.");
                    await CloseTransportAsync();
                    break;
                case DictationServerEventKind.TurnDone:
                    if (!serverEvent.Status.Equals("completed", StringComparison.OrdinalIgnoreCase) || string.IsNullOrWhiteSpace(transcript))
                        throw new InvalidDataException(serverEvent.Reason.Length > 0 ? serverEvent.Reason : "No literal transcript was returned.");
                    pendingAction = "";
                    finalizationGeneration += 1;
                    audioFrames?.Writer.TryComplete();
                    SetPhase(DictationPhase.Completed, "Literal transcript ready. Edit or copy it locally.");
                    await CloseTransportAsync();
                    break;
                case DictationServerEventKind.Failure:
                    await FailAsync(serverEvent.Text);
                    break;
            }
        }
        catch (Exception error)
        {
            await FailAsync(BoundedFailure(error, "Gateway returned invalid dictation data."));
        }
    }

    private async Task SendControlAsync(string action, DictationPhase phase, string message)
    {
        var current = pointer ?? throw new InvalidOperationException("No durable draft authority is available.");
        pendingAction = action;
        controlAck = new(TaskCreationOptions.RunContinuationsAsynchronously);
        SetPhase(phase, message);
        await RequireTransport().SendEventAsync(DictationProtocol.CreateControl(action, current), lifetime.Token);
        await controlAck.Task.WaitAsync(TimeSpan.FromSeconds(10), lifetime.Token);
        controlAck = null;
    }

    private void StartAudioPump()
    {
        audioFrames = Channel.CreateBounded<byte[]>(new BoundedChannelOptions(64)
        {
            FullMode = BoundedChannelFullMode.Wait,
            SingleReader = true,
            SingleWriter = false,
        });
        audioPump = Task.Run(async () =>
        {
            try
            {
                await foreach (var frame in audioFrames.Reader.ReadAllAsync(lifetime.Token))
                {
                    await RequireTransport().SendAudioAsync(frame, lifetime.Token);
                    if (Interlocked.Decrement(ref pendingAudio) == 0) audioDrained?.TrySetResult();
                }
            }
            catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
            catch (Exception error) { await FailAsync(BoundedFailure(error, "Microphone audio could not reach the gateway.")); }
        }, lifetime.Token);
    }

    private void StartMicrophone()
    {
        microphone.Start(QueueAudio, message => _ = FailAsync(message));
    }

    private void QueueAudio(ReadOnlyMemory<byte> frame)
    {
        if (Phase != DictationPhase.Listening || frame.IsEmpty || frame.Length > DictationProtocol.MaximumAudioFrameBytes
            || frame.Length % 2 != 0) return;
        var exact = frame.ToArray();
        var writer = audioFrames?.Writer;
        if (writer is null) return;
        if (Interlocked.Increment(ref pendingAudio) == 1)
            audioDrained = new(TaskCreationOptions.RunContinuationsAsynchronously);
        if (!writer.TryWrite(exact))
        {
            if (Interlocked.Decrement(ref pendingAudio) == 0) audioDrained?.TrySetResult();
            _ = FailAsync("Microphone audio exceeded the bounded gateway queue; capture stopped without sending.");
        }
    }

    private async Task DrainAudioAsync()
    {
        var waiter = audioDrained;
        if (Interlocked.Read(ref pendingAudio) == 0 || waiter is null) return;
        await waiter.Task.WaitAsync(TimeSpan.FromSeconds(10), lifetime.Token);
    }

    private async Task MonitorFinalizationAsync(int generation)
    {
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(90), lifetime.Token);
            if (generation == finalizationGeneration && Phase == DictationPhase.Finalizing)
                await FailAsync("Gateway did not finalize the literal transcript within 90 seconds.");
        }
        catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
    }

    private async Task FailAsync(string message)
    {
        microphone.Stop();
        audioFrames?.Writer.TryComplete();
        ready?.TrySetException(new InvalidDataException(message));
        controlAck?.TrySetException(new InvalidDataException(message));
        Fail(message);
        await CloseTransportAsync();
    }

    private void Fail(string message)
    {
        pendingAction = "";
        finalizationGeneration += 1;
        SetPhase(DictationPhase.Failed, message);
    }

    private async Task CloseTransportAsync()
    {
        var active = transport;
        transport = null;
        if (active is not null)
        {
            await active.CloseAsync();
            await active.DisposeAsync();
        }
    }

    private IVoiceDraftTransport RequireTransport() =>
        transport ?? throw new InvalidOperationException("Gateway dictation transport is unavailable.");

    private void SetPhase(DictationPhase phase, string message)
    {
        Phase = phase;
        status = message.Length <= 240 ? message : message[..240];
        Publish();
    }

    private void Publish()
    {
        StateChanged?.Invoke(BuildSnapshot());
    }

    private DictationSnapshot BuildSnapshot()
    {
        var retained = pointer ?? pointerStore.Load();
        var blockedByRetained = pointerStore.Exists && retained is null;
        return new DictationSnapshot(
            Phase,
            status,
            transcript,
            blockedByRetained ? "Retained draft pointer is unreadable; new capture is blocked"
                : retained is null ? "No retained draft" : $"Draft {retained.DraftId} · revision {retained.Revision} · {retained.State}",
            !blockedByRetained && (Phase is DictationPhase.Idle or DictationPhase.Completed or DictationPhase.Canceled or DictationPhase.Failed),
            Phase is DictationPhase.Listening or DictationPhase.Paused,
            Phase == DictationPhase.Listening,
            Phase == DictationPhase.Paused,
            Phase is DictationPhase.Listening or DictationPhase.Paused,
            Phase == DictationPhase.Completed && !string.IsNullOrWhiteSpace(transcript)
        );
    }

    private static string BoundedFailure(Exception error, string fallback)
    {
        var message = error is InvalidDataException or InvalidOperationException or ArgumentException
            ? error.Message
            : fallback;
        return message.Length <= 240 ? message : message[..240];
    }
}
