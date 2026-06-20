package ai.moa.assistant;

import android.media.AudioFormat;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.AudioTrack;

final class MoaAudioPlaybackController {
    static final int SAMPLE_RATE_HZ = 16000;
    static final int CHANNEL_COUNT = 1;
    static final String ENCODING = "pcm16";

    private static final int CHANNEL_CONFIG = AudioFormat.CHANNEL_OUT_MONO;
    private static final int AUDIO_FORMAT = AudioFormat.ENCODING_PCM_16BIT;
    private static final int PCM_BYTES_PER_SAMPLE = 2;
    private static final int MIN_BUFFER_MS = 250;

    interface Callback {
        void onPlaybackStarted();

        void onPlaybackStopped();

        void onPlaybackError(String message, Throwable error);
    }

    private final Callback callback;
    private final Object lock = new Object();

    private AudioTrack audioTrack;
    private boolean playing;

    MoaAudioPlaybackController(Callback callback) {
        this.callback = callback;
    }

    boolean isPlaying() {
        synchronized (lock) {
            return playing;
        }
    }

    void start() {
        synchronized (lock) {
            if (playing) {
                return;
            }
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
                audioTrack.play();
                playing = true;
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

    boolean write(byte[] pcm) {
        if (pcm == null || pcm.length == 0) {
            return false;
        }

        synchronized (lock) {
            if (!playing || audioTrack == null) {
                return false;
            }

            int offset = 0;
            while (offset < pcm.length && playing && audioTrack != null) {
                int written;
                try {
                    written = audioTrack.write(pcm, offset, pcm.length - offset);
                } catch (RuntimeException error) {
                    reportError("Audio playback write failed: " + cleanError(error) + ".", error);
                    return false;
                }

                if (written < 0) {
                    reportError("AudioTrack write failed with code " + written + ".", null);
                    return false;
                }
                if (written == 0) {
                    break;
                }
                offset += written;
            }
            return offset == pcm.length;
        }
    }

    void stop() {
        synchronized (lock) {
            if (!playing && audioTrack == null) {
                return;
            }
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
            callback.onPlaybackStopped();
        }
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
