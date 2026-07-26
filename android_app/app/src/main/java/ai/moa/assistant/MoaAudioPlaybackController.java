package ai.moa.assistant;

import android.media.AudioFormat;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.AudioTrack;
import android.media.PlaybackParams;
import android.util.Log;

final class MoaAudioPlaybackController {
    private static final String TAG = "MoaAudioPlayback";
    static final int SAMPLE_RATE_HZ = 16000;
    static final int CHANNEL_COUNT = 1;
    static final String ENCODING = "pcm16";
    // Per-turn playback_rate from assistant_audio_start is clamped to this
    // range before being handed to AudioTrack.setPlaybackParams(). setSpeed()
    // resamples, so it changes pitch along with speed -- that is the intended
    // "guaranteed speed" behavior for hosted voice playback, not a bug.
    static final double MIN_PLAYBACK_RATE = 0.5;
    static final double MAX_PLAYBACK_RATE = 2.0;

    private static final int CHANNEL_CONFIG = AudioFormat.CHANNEL_OUT_MONO;
    private static final int AUDIO_FORMAT = AudioFormat.ENCODING_PCM_16BIT;
    private static final int PCM_BYTES_PER_SAMPLE = 2;
    private static final int MIN_BUFFER_MS = 250;
    // Cap on a single native AudioTrack.write() call inside write() below. Under
    // multi-frame streaming a single PCM frame can carry a whole sentence (up to
    // voice-chunker's ~220-char maxChars, several seconds of audio); writing it
    // as one AudioTrack.write() would hold `lock` for that whole blocking
    // duration, so an interrupt's stop() (invoked from another thread) could not
    // acquire `lock` to pause/flush until the entire frame finished playing.
    // Slicing keeps each write()'s critical section down to ~100ms so stop()
    // can preempt within about one slice instead of one whole frame.
    private static final int MAX_WRITE_SLICE_MS = 100;
    private static final int MAX_WRITE_SLICE_BYTES =
            SAMPLE_RATE_HZ * PCM_BYTES_PER_SAMPLE * MAX_WRITE_SLICE_MS / 1000;

    interface Callback {
        void onPlaybackStarted();

        void onPlaybackStopped(boolean drained);

        void onPlaybackError(String message, Throwable error);
    }

    private final Callback callback;
    private final Object lock = new Object();

    private AudioTrack audioTrack;
    private boolean playing;
    // Where playback reached, in ms, captured inside stop() BEFORE the track's
    // head position is flushed. -1 = unavailable (never played this turn or the
    // head could not be read). Reset on start() so a prior turn cannot leak.
    private long lastPlayedMs = -1;
    private long totalPcmFramesWritten;
    private long playbackHeadWrapFrames;
    private long lastPlaybackHeadRawFrames;
    private long lastKnownPlayedPcmFrames;

    MoaAudioPlaybackController(Callback callback) {
        this.callback = callback;
    }

    boolean isPlaying() {
        synchronized (lock) {
            return playing;
        }
    }

    void start() {
        start(1.0);
    }

    // playbackRate comes from the per-turn assistant_audio_start event's
    // optional playback_rate field. Absent/invalid values must already have
    // been normalized to 1.0 by the caller; this method clamps defensively
    // again before touching the AudioTrack.
    void start(double playbackRate) {
        synchronized (lock) {
            if (playing) {
                return;
            }
            lastPlayedMs = -1;
            try {
                int minBufferSize = AudioTrack.getMinBufferSize(SAMPLE_RATE_HZ, CHANNEL_CONFIG, AUDIO_FORMAT);
                if (minBufferSize == AudioTrack.ERROR || minBufferSize == AudioTrack.ERROR_BAD_VALUE) {
                    reportError("AudioTrack does not support PCM16 mono at 16000 Hz.", null);
                    return;
                }

                int desiredBufferSize = SAMPLE_RATE_HZ * PCM_BYTES_PER_SAMPLE * MIN_BUFFER_MS / 1000;
                audioTrack = new AudioTrack(
                        new AudioAttributes.Builder()
                                .setUsage(AudioAttributes.USAGE_ASSISTANT)
                                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                                .build(),
                        new AudioFormat.Builder()
                                .setSampleRate(SAMPLE_RATE_HZ)
                                .setChannelMask(CHANNEL_CONFIG)
                                .setEncoding(AUDIO_FORMAT)
                                .build(),
                        Math.max(minBufferSize, desiredBufferSize),
                        AudioTrack.MODE_STREAM,
                        AudioManager.AUDIO_SESSION_ID_GENERATE
                );
                if (audioTrack.getState() != AudioTrack.STATE_INITIALIZED) {
                    releaseAudioTrack();
                    reportError("AudioTrack failed to initialize.", null);
                    return;
                }

                audioTrack.setVolume(AudioTrack.getMaxVolume());
                applyPlaybackRateLocked(playbackRate);
                audioTrack.play();
                playing = true;
                totalPcmFramesWritten = 0L;
                playbackHeadWrapFrames = 0L;
                lastPlaybackHeadRawFrames = 0L;
                lastKnownPlayedPcmFrames = 0L;
            } catch (RuntimeException error) {
                releaseAudioTrack();
                reportError("Audio playback could not start: " + cleanError(error) + ".", error);
                return;
            }
        }
        if (callback != null) {
            callback.onPlaybackStarted();
        }
    }

    // Caller must hold `lock` and audioTrack must be non-null/initialized.
    // A rate of 1.0 (the default when a turn carries no playback_rate) skips
    // setPlaybackParams entirely so playback matches pre-existing behavior
    // exactly. setSpeed() resamples, so speed and pitch move together; that
    // is the accepted trade-off for guaranteed up-to-2x playback speed.
    private void applyPlaybackRateLocked(double playbackRate) {
        double clamped = clampPlaybackRate(playbackRate);
        if (clamped == 1.0) {
            return;
        }
        try {
            PlaybackParams params = audioTrack.getPlaybackParams();
            params.setSpeed((float) clamped);
            audioTrack.setPlaybackParams(params);
        } catch (RuntimeException error) {
            Log.w(TAG, "setPlaybackParams(speed=" + clamped + ") failed: " + cleanError(error) + "; playing at 1.0x");
        }
    }

    static double clampPlaybackRate(double rate) {
        if (Double.isNaN(rate) || Double.isInfinite(rate) || rate <= 0) {
            return 1.0;
        }
        if (rate < MIN_PLAYBACK_RATE) {
            return MIN_PLAYBACK_RATE;
        }
        if (rate > MAX_PLAYBACK_RATE) {
            return MAX_PLAYBACK_RATE;
        }
        return rate;
    }

    static long pcmFramesToBytes(long frames) {
        if (frames <= 0L) {
            return 0L;
        }
        return frames * PCM_BYTES_PER_SAMPLE;
    }

    static long pcmBytesToFrames(long bytes) {
        if (bytes <= 0L) {
            return 0L;
        }
        return bytes / PCM_BYTES_PER_SAMPLE;
    }

    boolean write(byte[] pcm) {
        if (pcm == null || pcm.length == 0) {
            return false;
        }

        // Each slice's blocking AudioTrack.write() runs inside its own
        // synchronized(lock) instead of one synchronized block wrapping the
        // whole frame. That lets stop() (called from another thread on a
        // barge-in) acquire `lock` between slices and flip `playing`/`
        // audioTrack` promptly, instead of waiting out an entire multi-second
        // frame's worth of blocking writes before it can even start pausing.
        int offset = 0;
        while (offset < pcm.length) {
            int written;
            synchronized (lock) {
                if (!playing || audioTrack == null) {
                    return false;
                }
                int sliceLength = Math.min(pcm.length - offset, MAX_WRITE_SLICE_BYTES);
                try {
                    written = audioTrack.write(pcm, offset, sliceLength);
                } catch (RuntimeException error) {
                    reportError("Audio playback write failed: " + cleanError(error) + ".", error);
                    return false;
                }

                if (written < 0) {
                    reportError("AudioTrack write failed with code " + written + ".", null);
                    return false;
                }
                totalPcmFramesWritten += pcmBytesToFrames(written);
            }
            if (written == 0) {
                break;
            }
            offset += written;
        }
        return offset == pcm.length;
    }

    // Where playback stopped, in ms, as of the last stop(). -1 when unavailable.
    // Read after stop() to tell the gateway how much assistant audio the user
    // actually heard before interrupting.
    long lastPlayedMs() {
        synchronized (lock) {
            return lastPlayedMs;
        }
    }

    // Live played position in ms while the track is still active. -1 when the
    // track is released/null or the head position is unreadable.
    long playedMs() {
        synchronized (lock) {
            return currentPlayedMsLocked();
        }
    }

    // Caller must hold `lock`. Reads the AudioTrack playback head (a frame
    // count) and converts to ms via the fixed 16000 Hz track sample rate.
    // getPlaybackHeadPosition() is a signed frame count; a negative reading (or
    // a released/throwing track) is treated as unavailable and returns -1.
    private long currentPlayedMsLocked() {
        if (audioTrack == null) {
            return -1;
        }
        try {
            int frames = audioTrack.getPlaybackHeadPosition();
            if (frames < 0) {
                return -1;
            }
            return (long) frames * 1000L / SAMPLE_RATE_HZ;
        } catch (RuntimeException error) {
            return -1;
        }
    }

    long playedPcmFrames() {
        synchronized (lock) {
            return currentPlayedPcmFramesLocked();
        }
    }

    long writtenPcmFrames() {
        synchronized (lock) {
            return totalPcmFramesWritten;
        }
    }

    void stop() {
        stop(false);
    }

    private void stop(boolean drained) {
        synchronized (lock) {
            if (!playing && audioTrack == null) {
                return;
            }
            // Capture where playback reached BEFORE pause()/flush(): flush()
            // resets the head position to 0, so reading it afterwards would
            // always report 0. Stored for lastPlayedMs().
            lastPlayedMs = currentPlayedMsLocked();
            lastKnownPlayedPcmFrames = currentPlayedPcmFramesLocked();
            playing = false;
            if (audioTrack != null) {
                try {
                    audioTrack.pause();
                    audioTrack.flush();
                } catch (IllegalStateException ignored) {
                }
            }
            releaseAudioTrack();
        }
        if (callback != null) {
            callback.onPlaybackStopped(drained);
        }
    }

    void drainAndStop(long timeoutMs) {
        long playedAtStart;
        long writtenAtStart;
        synchronized (lock) {
            playedAtStart = currentPlayedPcmFramesLocked();
            writtenAtStart = totalPcmFramesWritten;
        }
        long remainingFrames = Math.max(0L, writtenAtStart - playedAtStart);
        long expectedRemainingMs = remainingFrames * 1000L / SAMPLE_RATE_HZ;
        final long boundedTimeoutMs = Math.max(
                1000L,
                Math.min(Math.min(timeoutMs, 60000L), expectedRemainingMs + 2000L));
        new Thread(() -> {
            long deadline = android.os.SystemClock.elapsedRealtime() + boundedTimeoutMs;
            boolean drained = false;
            while (android.os.SystemClock.elapsedRealtime() < deadline) {
                synchronized (lock) {
                    if (!playing || audioTrack == null) {
                        return;
                    }
                    drained = totalPcmFramesWritten > 0L
                            && currentPlayedPcmFramesLocked() >= totalPcmFramesWritten;
                }
                if (drained) break;
                try {
                    Thread.sleep(20L);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    return;
                }
            }
            if (!drained && callback != null) {
                callback.onPlaybackError("Audio playback drain timed out.", null);
            }
            stop(drained);
        }, "moa-audio-drain").start();
    }

    private void releaseAudioTrack() {
        if (audioTrack == null) {
            return;
        }
        try {
            audioTrack.release();
        } catch (RuntimeException ignored) {
        }
        audioTrack = null;
    }

    private long currentPlayedPcmFramesLocked() {
        if (audioTrack == null) {
            return Math.min(lastKnownPlayedPcmFrames, totalPcmFramesWritten);
        }
        try {
            long rawFrames = audioTrack.getPlaybackHeadPosition() & 0xffffffffL;
            if (rawFrames < lastPlaybackHeadRawFrames) {
                playbackHeadWrapFrames += (1L << 32);
            }
            lastPlaybackHeadRawFrames = rawFrames;
            long playedFrames = playbackHeadWrapFrames + rawFrames;
            long bounded = Math.min(playedFrames, totalPcmFramesWritten);
            if (bounded > lastKnownPlayedPcmFrames) {
                lastKnownPlayedPcmFrames = bounded;
            }
        } catch (RuntimeException error) {
            Log.w(TAG, "getPlaybackHeadPosition() failed: " + cleanError(error));
        }
        return Math.min(lastKnownPlayedPcmFrames, totalPcmFramesWritten);
    }

    private void reportError(String message, Throwable error) {
        if (callback != null) {
            callback.onPlaybackError(message, error);
        }
    }

    private static String cleanError(Throwable error) {
        String message = error.getMessage();
        if (message == null || message.trim().isEmpty()) {
            return error.getClass().getSimpleName();
        }
        return message.replace('\n', ' ').replace('\r', ' ').trim();
    }
}
