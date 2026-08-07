using System.Net.WebSockets;
using System.Text;

namespace Aggie.Windows;

public interface IVoiceDraftTransport : IAsyncDisposable
{
    Task ConnectAsync(
        Uri gatewayOrigin,
        string bearerToken,
        string sessionStart,
        Func<string, Task> eventHandler,
        Func<string, Task> failureHandler,
        CancellationToken cancellationToken
    );
    Task SendAudioAsync(ReadOnlyMemory<byte> pcm16, CancellationToken cancellationToken);
    Task SendEventAsync(string json, CancellationToken cancellationToken);
    Task CloseAsync();
}

public sealed class GatewayVoiceDraftTransport : IVoiceDraftTransport
{
    private readonly SemaphoreSlim sendGate = new(1, 1);
    private readonly CancellationTokenSource lifetime = new();
    private ClientWebSocket? socket;
    private Task? receiver;

    public async Task ConnectAsync(
        Uri gatewayOrigin,
        string bearerToken,
        string sessionStart,
        Func<string, Task> eventHandler,
        Func<string, Task> failureHandler,
        CancellationToken cancellationToken
    )
    {
        if (socket is not null) throw new InvalidOperationException("A dictation connection is already active.");
        if (string.IsNullOrWhiteSpace(bearerToken) || bearerToken.Any(char.IsWhiteSpace))
            throw new InvalidOperationException("A gateway session credential is required.");
        var endpoint = VoiceEndpoint(gatewayOrigin);
        var next = new ClientWebSocket();
        next.Options.SetRequestHeader("Authorization", $"Bearer {bearerToken}");
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, lifetime.Token);
        await next.ConnectAsync(endpoint, linked.Token);
        socket = next;
        await SendEventAsync(sessionStart, linked.Token);
        receiver = ReceiveLoopAsync(next, eventHandler, failureHandler, lifetime.Token);
    }

    public async Task SendAudioAsync(ReadOnlyMemory<byte> pcm16, CancellationToken cancellationToken)
    {
        if (pcm16.IsEmpty || pcm16.Length > DictationProtocol.MaximumAudioFrameBytes || pcm16.Length % 2 != 0)
            throw new InvalidDataException("Microphone audio frame was empty, odd, or oversized.");
        await SendAsync(pcm16, WebSocketMessageType.Binary, cancellationToken);
    }

    public async Task SendEventAsync(string json, CancellationToken cancellationToken)
    {
        var bytes = Encoding.UTF8.GetBytes(json);
        if (bytes.Length == 0 || bytes.Length > DictationProtocol.MaximumEventBytes)
            throw new InvalidDataException("Client event was empty or oversized.");
        await SendAsync(bytes, WebSocketMessageType.Text, cancellationToken);
    }

    public async Task CloseAsync()
    {
        lifetime.Cancel();
        var active = socket;
        socket = null;
        if (active is not null)
        {
            try
            {
                if (active.State is WebSocketState.Open or WebSocketState.CloseReceived)
                    await active.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "dictation closed", CancellationToken.None);
            }
            catch (WebSocketException) { }
            active.Dispose();
        }
        if (receiver is not null)
        {
            try { await Task.WhenAny(receiver, Task.Delay(1_000)); } catch (OperationCanceledException) { }
            receiver = null;
        }
    }

    public async ValueTask DisposeAsync()
    {
        await CloseAsync();
        lifetime.Dispose();
        sendGate.Dispose();
    }

    private async Task SendAsync(ReadOnlyMemory<byte> value, WebSocketMessageType type, CancellationToken cancellationToken)
    {
        var active = socket;
        if (active is null || active.State != WebSocketState.Open)
            throw new WebSocketException("The gateway dictation connection is not open.");
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, lifetime.Token);
        await sendGate.WaitAsync(linked.Token);
        try
        {
            await active.SendAsync(value, type, true, linked.Token);
        }
        finally
        {
            sendGate.Release();
        }
    }

    private static async Task ReceiveLoopAsync(
        ClientWebSocket active,
        Func<string, Task> eventHandler,
        Func<string, Task> failureHandler,
        CancellationToken cancellationToken
    )
    {
        var buffer = new byte[8 * 1024];
        try
        {
            while (!cancellationToken.IsCancellationRequested && active.State == WebSocketState.Open)
            {
                using var message = new MemoryStream();
                WebSocketReceiveResult result;
                do
                {
                    result = await active.ReceiveAsync(new ArraySegment<byte>(buffer), cancellationToken);
                    if (result.MessageType == WebSocketMessageType.Close) return;
                    if (result.MessageType == WebSocketMessageType.Binary)
                        throw new InvalidDataException("Assistant audio is invalid on literal dictation.");
                    if (message.Length + result.Count > DictationProtocol.MaximumEventBytes)
                        throw new InvalidDataException("Gateway event exceeded the client bound.");
                    message.Write(buffer, 0, result.Count);
                } while (!result.EndOfMessage);
                await eventHandler(Encoding.UTF8.GetString(message.ToArray()));
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { }
        catch (Exception error)
        {
            await failureHandler(BoundedFailure(error));
        }
    }

    private static Uri VoiceEndpoint(Uri origin)
    {
        if (!origin.IsAbsoluteUri || !string.IsNullOrEmpty(origin.UserInfo) || !string.IsNullOrEmpty(origin.Query)
            || !string.IsNullOrEmpty(origin.Fragment) || origin.AbsolutePath is not ("" or "/"))
            throw new InvalidOperationException("Gateway origin must contain only scheme and host.");
        var secure = origin.Scheme.Equals("https", StringComparison.OrdinalIgnoreCase);
        var loopback = origin.IsLoopback && origin.Scheme.Equals("http", StringComparison.OrdinalIgnoreCase);
        if (!secure && !loopback) throw new InvalidOperationException("Gateway origin must use HTTPS, except loopback development.");
        return new UriBuilder(origin)
        {
            Scheme = secure ? "wss" : "ws",
            Path = "/v1/voice/sessions",
        }.Uri;
    }

    private static string BoundedFailure(Exception error)
    {
        var message = error is InvalidDataException ? error.Message : "Gateway dictation connection was interrupted.";
        return message.Length <= 240 ? message : message[..240];
    }
}
