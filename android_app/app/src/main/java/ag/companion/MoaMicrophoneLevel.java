package ag.companion;

/** Process-local, content-free microphone activity signal for presentation only. */
final class MoaMicrophoneLevel {
    interface Listener {
        void onHardwareState(boolean open);
        void onLevel(float level);
    }

    private static volatile Listener listener;

    private MoaMicrophoneLevel() {}

    static void observe(Listener value) { listener = value; }

    static void hardwareState(boolean open) {
        Listener current = listener;
        if (current != null) current.onHardwareState(open);
    }

    static void pcm(byte[] pcm) {
        Listener current = listener;
        if (current != null) current.onLevel(normalizePcm16(pcm));
    }

    static float normalizePcm16(byte[] pcm) {
        if (pcm == null || pcm.length < 2) return 0f;
        double sum = 0d;
        int samples = pcm.length / 2;
        for (int i = 0; i + 1 < pcm.length; i += 2) {
            int sample = (short) ((pcm[i] & 0xff) | (pcm[i + 1] << 8));
            double normalized = sample / 32768d;
            sum += normalized * normalized;
        }
        double rms = Math.sqrt(sum / samples);
        return clamp((float) ((rms - 0.008d) / 0.22d));
    }

    static float smooth(float previous, float incoming) {
        float next = clamp(incoming);
        float weight = next > previous ? 0.52f : 0.18f;
        return clamp(previous + (next - previous) * weight);
    }

    private static float clamp(float value) {
        return Math.max(0f, Math.min(1f, value));
    }
}
