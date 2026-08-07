using NAudio.Wave;

namespace Aggie.Windows;

public interface IPcm16MicrophoneCapture : IDisposable
{
    bool IsActive { get; }
    void Start(Action<ReadOnlyMemory<byte>> frameHandler, Action<string> failureHandler);
    void Stop();
}

/// <summary>
/// Windows-owned microphone adapter. It requests mono 16 kHz PCM16 directly
/// from the desktop wave-input stack and retains no audio after each callback.
/// </summary>
public sealed class Pcm16MicrophoneCapture : IPcm16MicrophoneCapture
{
    private readonly object gate = new();
    private WaveInEvent? capture;
    public bool IsActive { get { lock (gate) return capture is not null; } }

    public void Start(Action<ReadOnlyMemory<byte>> frameHandler, Action<string> failureHandler)
    {
        lock (gate)
        {
            if (capture is not null) throw new InvalidOperationException("Microphone capture is already active.");
            var next = new WaveInEvent
            {
                BufferMilliseconds = 50,
                NumberOfBuffers = 3,
                WaveFormat = new WaveFormat(16_000, 16, 1),
            };
            next.DataAvailable += (_, eventArgs) =>
            {
                if (eventArgs.BytesRecorded <= 0) return;
                var exact = new byte[eventArgs.BytesRecorded];
                Buffer.BlockCopy(eventArgs.Buffer, 0, exact, 0, exact.Length);
                frameHandler(exact);
            };
            next.RecordingStopped += (_, eventArgs) =>
            {
                if (eventArgs.Exception is not null)
                    failureHandler("Windows stopped microphone capture. Check microphone privacy settings and retry.");
            };
            try
            {
                next.StartRecording();
                capture = next;
            }
            catch
            {
                next.Dispose();
                throw;
            }
        }
    }

    public void Stop()
    {
        WaveInEvent? active;
        lock (gate)
        {
            active = capture;
            capture = null;
        }
        if (active is null) return;
        try { active.StopRecording(); }
        finally { active.Dispose(); }
    }

    public void Dispose() => Stop();
}
