package ag.companion;

/** Deterministic phase and token policy for Minimal presentation. */
final class MoaMinimalRingVisualState {
    enum Phase { IDLE, CAPTURING, PAUSED, THINKING, SPEAKING, ERROR }

    final Phase phase;
    final boolean microphoneOpen;
    final int color;
    final float alpha;
    final boolean animate;

    private MoaMinimalRingVisualState(
            Phase phase, boolean microphoneOpen, int color, float alpha, boolean animate) {
        this.phase = phase;
        this.microphoneOpen = microphoneOpen;
        this.color = color;
        this.alpha = alpha;
        this.animate = animate;
    }

    static MoaMinimalRingVisualState resolve(
            VoiceRuntimeState runtime, boolean microphoneOpen, boolean reducedMotion,
            boolean highContrast) {
        VoiceRuntimeState state = runtime == null ? VoiceRuntimeState.READY : runtime;
        Phase phase;
        if (microphoneOpen) phase = Phase.CAPTURING;
        else switch (state) {
            case LISTENING: phase = Phase.PAUSED; break;
            case SENDING:
            case THINKING: phase = Phase.THINKING; break;
            case SPEAKING: phase = Phase.SPEAKING; break;
            case ERROR:
            case RECOVERING: phase = Phase.ERROR; break;
            default: phase = Phase.IDLE;
        }
        int color;
        switch (phase) {
            case CAPTURING: color = highContrast ? 0xFFFFFFFF : MoaColors.VIOLET; break;
            case PAUSED: color = highContrast ? 0xFFFFFFFF : MoaColors.MUTED; break;
            case THINKING: color = highContrast ? 0xFFFFFFFF : MoaColors.GOLD; break;
            case SPEAKING: color = highContrast ? 0xFFFFFFFF : MoaColors.GREEN; break;
            case ERROR: color = highContrast ? 0xFFFFFFFF : MoaColors.RED; break;
            default: color = highContrast ? 0xFFFFFFFF : MoaColors.AMBER;
        }
        float alpha = phase == Phase.IDLE ? 0.42f : (highContrast ? 1f : 0.82f);
        boolean animate = !reducedMotion
                && (phase == Phase.CAPTURING || phase == Phase.THINKING || phase == Phase.SPEAKING);
        return new MoaMinimalRingVisualState(phase, microphoneOpen, color, alpha, animate);
    }

    float intensity(float smoothedLevel, float motionPhase) {
        float bounded = Math.max(0f, Math.min(1f, smoothedLevel));
        if (microphoneOpen) return 0.22f + bounded * 0.78f;
        if (!animate) return 0.35f;
        return 0.35f + 0.18f * (0.5f + 0.5f * (float) Math.sin(motionPhase));
    }
}
