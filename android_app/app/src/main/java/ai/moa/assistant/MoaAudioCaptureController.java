package ai.moa.assistant;

import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;

import java.util.Arrays;

final class MoaAudioCaptureController {
    static final int SAMPLE_RATE_HZ = 16000;
    static final int CHANNEL_COUNT = 1;
    static final String ENCODING = "pcm16";

    private static final int CHANNEL_CONFIG = AudioFormat.CHANNEL_IN_MONO;
    private static final int AUDIO_FORMAT = AudioFormat.ENCODING_PCM_16BIT;
    private static final int PCM_BYTES_PER_SAMPLE = 2;
    private static final int CHUNK_MS = 40;
    private static final int CHUNK_BYTES = SAMPLE_RATE_HZ * PCM_BYTES_PER_SAMPLE * CHUNK_MS / 1000;

    interface Callback {
        void onPcmChunk(byte[] pcm);

        void onCaptureStarted();

        void onCaptureStopped();

        void onCaptureError(String message, Throwable error);
    }

    private final Callback callback;
    private final Object lock = new Object();

    private AudioRecord audioRecord;
    private Thread captureThread;
    private volatile boolean recording;

    MoaAudioCaptureController(Callback callback) {
        this.callback = callback;
    }

    boolean isRecording() {
        return recording;
    }

    void start() {
        synchronized (lock) {
            if (recording) {
                return;
            }
            try {
                int minBufferSize = AudioRecord.getMinBufferSize(SAMPLE_RATE_HZ, CHANNEL_CONFIG, AUDIO_FORMAT);
                if (minBufferSize == AudioRecord.ERROR || minBufferSize == AudioRecord.ERROR_BAD_VALUE) {
                    reportError("AudioRecord does not support PCM16 mono at 16000 Hz.", null);
                    return;
                }

                int bufferSize = Math.max(minBufferSize, CHUNK_BYTES * 2);
                audioRecord = new AudioRecord(
                        MediaRecorder.AudioSource.MIC,
                        SAMPLE_RATE_HZ,
                        CHANNEL_CONFIG,
                        AUDIO_FORMAT,
                        bufferSize
                );
                if (audioRecord.getState() != AudioRecord.STATE_INITIALIZED) {
                    releaseAudioRecord();
                    reportError("AudioRecord failed to initialize.", null);
                    return;
                }

                audioRecord.startRecording();
                recording = true;
                captureThread = new Thread(this::readLoop, "moa-audio-capture");
                captureThread.start();
            } catch (SecurityException error) {
                releaseAudioRecord();
                reportError("Microphone permission is missing.", error);
                return;
            } catch (RuntimeException error) {
                releaseAudioRecord();
                reportError("Audio capture could not start: " + cleanError(error) + ".", error);
                return;
            }
        }
        if (callback != null) {
            callback.onCaptureStarted();
        }
    }

    void stop() {
        Thread threadToJoin;
        synchronized (lock) {
            if (!recording && audioRecord == null) {
                return;
            }
            recording = false;
            stopAudioRecord();
            threadToJoin = captureThread;
        }

        if (threadToJoin != null && threadToJoin != Thread.currentThread()) {
            try {
                threadToJoin.join(500);
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
            }
        }

        synchronized (lock) {
            releaseAudioRecord();
            captureThread = null;
        }
        if (callback != null) {
            callback.onCaptureStopped();
        }
    }

    private void readLoop() {
        byte[] buffer = new byte[CHUNK_BYTES];
        while (recording) {
            AudioRecord record = audioRecord;
            if (record == null) {
                break;
            }

            int read = record.read(buffer, 0, buffer.length);
            if (read > 0) {
                if (callback != null) {
                    callback.onPcmChunk(Arrays.copyOf(buffer, read));
                }
            } else if (read < 0 && recording) {
                reportError("AudioRecord read failed with code " + read + ".", null);
                stop();
                break;
            }
        }
    }

    private void stopAudioRecord() {
        if (audioRecord == null) {
            return;
        }
        try {
            audioRecord.stop();
        } catch (IllegalStateException ignored) {
        }
    }

    private void releaseAudioRecord() {
        if (audioRecord == null) {
            return;
        }
        try {
            audioRecord.release();
        } catch (RuntimeException ignored) {
        }
        audioRecord = null;
    }

    private void reportError(String message, Throwable error) {
        if (callback != null) {
            callback.onCaptureError(message, error);
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
