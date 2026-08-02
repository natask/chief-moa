package ag.companion;

import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

// One microphone lifecycle spanning warm -> live -> warm. The gesture warms the
// mic up front (paying the 100-300ms AudioRecord cold-start while the double-press
// is still confirming) and fills a bounded pre-roll ring, so the head of an
// utterance spoken before the hold engages is not lost. On go-live the same
// already-running AudioRecord is handed to the session: the pre-roll drains first
// (in order, on the capture thread) and then live chunks continue. The whole
// warm/drain/stop dance is race-free with a caller's stop() + thread join.
final class MoaAudioCaptureController {
    static final int SAMPLE_RATE_HZ = 16000;
    static final int CHANNEL_COUNT = 1;
    static final String ENCODING = "pcm16";

    private static final int CHANNEL_CONFIG = AudioFormat.CHANNEL_IN_MONO;
    private static final int AUDIO_FORMAT = AudioFormat.ENCODING_PCM_16BIT;
    private static final int PCM_BYTES_PER_SAMPLE = 2;
    private static final int CHUNK_MS = 40;
    private static final int CHUNK_BYTES = SAMPLE_RATE_HZ * PCM_BYTES_PER_SAMPLE * CHUNK_MS / 1000;
    // ~500ms of 16kHz PCM16 mono = 16000 bytes. The warm-up read loop keeps at
    // most this much of the most-recent audio; older frames are dropped from the
    // front so the ring stays bounded no matter how long the mic stays warm.
    private static final int PRE_ROLL_TARGET_BYTES = SAMPLE_RATE_HZ * PCM_BYTES_PER_SAMPLE * 500 / 1000;

    interface Callback {
        void onPcmChunk(byte[] pcm);

        void onCaptureStarted();

        void onCaptureStopped();

        void onCaptureError(String message, Throwable error);
    }

    private final Object lock = new Object();

    private AudioRecord audioRecord;
    private Thread captureThread;
    // AudioRecord is running (either warming into the ring or delivering live).
    private volatile boolean recording;
    // Warming = the hardware is hot and the read loop is filling the pre-roll
    // ring, but no live callback is attached yet. Guarded by lock for the
    // warm -> live transition; volatile so the read loop sees the flip promptly.
    private volatile boolean warming;
    private Callback callback;
    private final ArrayDeque<byte[]> preRoll = new ArrayDeque<>();
    private int preRollBytes;
    // Whether to deliver the pre-roll on go-live. Push-to-talk drains it to catch
    // the head of speech; the silence-VAD (continuous) path drops it so stale gap
    // audio from between turns never trips voice-activity detection.
    private boolean drainPreRollOnGoLive = true;

    MoaAudioCaptureController() {
    }

    boolean isRecording() {
        return recording;
    }

    boolean isWarming() {
        return warming;
    }

    // Live = the AudioRecord is running and delivering chunks to a live callback.
    boolean isLive() {
        return recording && !warming;
    }

    // Spin the microphone up without attaching a live callback. The read loop
    // fills the pre-roll ring; nothing is delivered until start() goes live. Safe
    // to call on an idle controller; a no-op while already warming or live.
    void warmUp() {
        synchronized (lock) {
            if (recording) {
                return;
            }
            if (!openAudioRecordLocked()) {
                return;
            }
            warming = true;
            callback = null;
            preRoll.clear();
            preRollBytes = 0;
            recording = true;
            captureThread = new Thread(this::readLoop, "moa-audio-capture");
            captureThread.start();
        }
    }

    void start(Callback callback) {
        start(callback, true);
    }

    // Attach a live callback and begin delivering audio. If the mic was warming,
    // hand the already-running AudioRecord to the caller: the read loop drains the
    // pre-roll (optionally) and then continues live. If the mic is idle, cold-start
    // a fresh AudioRecord with this callback. A no-op if already live.
    void start(Callback callback, boolean drainPreRoll) {
        synchronized (lock) {
            if (recording && !warming) {
                return;
            }
            this.callback = callback;
            this.drainPreRollOnGoLive = drainPreRoll;
            if (warming) {
                // Go live: the read loop drains the ring and continues once it
                // observes warming cleared. Done on the capture thread so order is
                // preserved and stop()'s join sees every drained frame.
                warming = false;
            } else {
                if (!openAudioRecordLocked()) {
                    return;
                }
                preRoll.clear();
                preRollBytes = 0;
                recording = true;
                captureThread = new Thread(this::readLoop, "moa-audio-capture");
                captureThread.start();
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
            warming = false;
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
                byte[] chunk = Arrays.copyOf(buffer, read);
                MoaMicrophoneLevel.pcm(chunk);
                Callback target;
                List<byte[]> drained = null;
                synchronized (lock) {
                    if (warming) {
                        addToPreRollLocked(chunk);
                        continue;
                    }
                    target = callback;
                    if (!preRoll.isEmpty()) {
                        if (drainPreRollOnGoLive) {
                            drained = new ArrayList<>(preRoll);
                        }
                        preRoll.clear();
                        preRollBytes = 0;
                    }
                }
                if (target != null) {
                    if (drained != null) {
                        for (byte[] pre : drained) {
                            target.onPcmChunk(pre);
                        }
                    }
                    target.onPcmChunk(chunk);
                }
            } else if (read < 0 && recording) {
                reportError("AudioRecord read failed with code " + read + ".", null);
                stop();
                break;
            }
        }
        // Stopped (or errored) while live before the ring drained on a read: flush
        // it now so an ultra-short hold still counts + sends the head of the
        // utterance. Runs on the capture thread, so a caller's stop() join sees it.
        flushPreRollAfterLoop();
    }

    private void flushPreRollAfterLoop() {
        Callback target;
        List<byte[]> drained = null;
        synchronized (lock) {
            target = callback;
            if (!warming && target != null && drainPreRollOnGoLive && !preRoll.isEmpty()) {
                drained = new ArrayList<>(preRoll);
            }
            preRoll.clear();
            preRollBytes = 0;
        }
        if (target != null && drained != null) {
            for (byte[] pre : drained) {
                target.onPcmChunk(pre);
            }
        }
    }

    private void addToPreRollLocked(byte[] chunk) {
        preRoll.addLast(chunk);
        preRollBytes += chunk.length;
        while (preRollBytes > PRE_ROLL_TARGET_BYTES && !preRoll.isEmpty()) {
            byte[] dropped = preRoll.removeFirst();
            preRollBytes = Math.max(0, preRollBytes - dropped.length);
        }
    }

    private boolean openAudioRecordLocked() {
        try {
            int minBufferSize = AudioRecord.getMinBufferSize(SAMPLE_RATE_HZ, CHANNEL_CONFIG, AUDIO_FORMAT);
            if (minBufferSize == AudioRecord.ERROR || minBufferSize == AudioRecord.ERROR_BAD_VALUE) {
                reportError("AudioRecord does not support PCM16 mono at 16000 Hz.", null);
                return false;
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
                return false;
            }

            audioRecord.startRecording();
            MoaMicrophoneLevel.hardwareState(true);
            return true;
        } catch (SecurityException error) {
            releaseAudioRecord();
            reportError("Microphone permission is missing.", error);
            return false;
        } catch (RuntimeException error) {
            releaseAudioRecord();
            reportError("Audio capture could not start: " + cleanError(error) + ".", error);
            return false;
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
        MoaMicrophoneLevel.hardwareState(false);
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
