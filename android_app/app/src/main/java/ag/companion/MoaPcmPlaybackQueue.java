package ag.companion;

import java.util.ArrayDeque;

/** Pure bounded FIFO that keeps blocking device writes off the WebSocket callback. */
final class MoaPcmPlaybackQueue {
    enum OfferResult {
        ACCEPTED,
        CLOSED,
        OVERFLOW
    }

    interface Writer {
        boolean write(byte[] pcm);
    }

    interface Listener {
        void onDrained(long acceptedBytes);

        void onOverflow(int pendingBytes, int offeredBytes);

        void onWriteFailed();
    }

    private final Object lock = new Object();
    private final int maxPendingBytes;
    private final Writer writer;
    private final Listener listener;
    private final ArrayDeque<byte[]> pending = new ArrayDeque<>();

    private int pendingBytes;
    private long acceptedBytes;
    private boolean finishRequested;
    private boolean canceled;
    private Thread worker;

    MoaPcmPlaybackQueue(int maxPendingBytes, Writer writer, Listener listener) {
        if (maxPendingBytes <= 0) {
            throw new IllegalArgumentException("maxPendingBytes must be positive");
        }
        this.maxPendingBytes = maxPendingBytes;
        this.writer = writer;
        this.listener = listener;
    }

    OfferResult offer(byte[] pcm) {
        if (pcm == null || pcm.length == 0) {
            return OfferResult.CLOSED;
        }
        int overflowPending;
        synchronized (lock) {
            if (finishRequested || canceled) {
                return OfferResult.CLOSED;
            }
            if (pcm.length > maxPendingBytes - pendingBytes) {
                overflowPending = pendingBytes;
            } else {
                pending.addLast(pcm);
                pendingBytes += pcm.length;
                acceptedBytes += pcm.length;
                ensureWorkerLocked();
                lock.notifyAll();
                return OfferResult.ACCEPTED;
            }
        }
        if (listener != null) {
            listener.onOverflow(overflowPending, pcm.length);
        }
        return OfferResult.OVERFLOW;
    }

    void finish() {
        synchronized (lock) {
            if (canceled || finishRequested) {
                return;
            }
            finishRequested = true;
            ensureWorkerLocked();
            lock.notifyAll();
        }
    }

    void cancel() {
        Thread toInterrupt;
        synchronized (lock) {
            if (canceled) {
                return;
            }
            canceled = true;
            pending.clear();
            pendingBytes = 0;
            toInterrupt = worker;
            lock.notifyAll();
        }
        if (toInterrupt != null) {
            toInterrupt.interrupt();
        }
    }

    int pendingBytes() {
        synchronized (lock) {
            return pendingBytes;
        }
    }

    private void ensureWorkerLocked() {
        if (worker != null) {
            return;
        }
        worker = new Thread(this::runWorker, "moa-assistant-pcm");
        worker.start();
    }

    private void runWorker() {
        long totalAccepted;
        while (true) {
            byte[] pcm;
            synchronized (lock) {
                while (pending.isEmpty() && !finishRequested && !canceled) {
                    try {
                        lock.wait();
                    } catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();
                        return;
                    }
                }
                if (canceled) {
                    return;
                }
                pcm = pending.pollFirst();
                if (pcm == null) {
                    totalAccepted = acceptedBytes;
                    break;
                }
                pendingBytes = Math.max(0, pendingBytes - pcm.length);
            }
            if (writer == null || !writer.write(pcm)) {
                synchronized (lock) {
                    pending.clear();
                    pendingBytes = 0;
                    canceled = true;
                }
                if (listener != null) {
                    listener.onWriteFailed();
                }
                return;
            }
        }
        if (listener != null) {
            listener.onDrained(totalAccepted);
        }
    }
}
