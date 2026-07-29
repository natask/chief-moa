package ag.companion;

import java.util.EnumMap;

/** Durable instructional progress reconciled with live Android capability state. */
final class AgOnboardingState {
    enum Capability { CONNECTION, MICROPHONE, FIRST_CONVERSATION, NOTIFICATIONS, OVERLAY, ACCESSIBILITY, MEDIA }
    enum Stage { NOT_REQUESTED, EXPLAINED, OPENED, RETURNED, VERIFIED_ENABLED, DECLINED, BLOCKED, DEMONSTRATED }

    static final class LiveState {
        final boolean connected;
        final boolean microphone;
        final boolean conversationCompleted;
        final boolean notifications;

        LiveState(boolean connected, boolean microphone, boolean conversationCompleted, boolean notifications) {
            this.connected = connected;
            this.microphone = microphone;
            this.conversationCompleted = conversationCompleted;
            this.notifications = notifications;
        }
    }

    private final EnumMap<Capability, Stage> stored;

    AgOnboardingState(EnumMap<Capability, Stage> stored) {
        this.stored = new EnumMap<>(Capability.class);
        if (stored != null) this.stored.putAll(stored);
    }

    Stage stage(Capability capability, LiveState live) {
        if (isLiveEnabled(capability, live)) return Stage.VERIFIED_ENABLED;
        Stage cached = stored.getOrDefault(capability, Stage.NOT_REQUESTED);
        // Cached success is instructional progress, never permission authority.
        return cached == Stage.VERIFIED_ENABLED || cached == Stage.DEMONSTRATED
                ? Stage.RETURNED : cached;
    }

    Capability nextRequired(LiveState live) {
        if (!live.connected) return Capability.CONNECTION;
        if (!live.microphone) return Capability.MICROPHONE;
        if (!live.conversationCompleted) return Capability.FIRST_CONVERSATION;
        if (!live.notifications) return Capability.NOTIFICATIONS;
        return null;
    }

    static Stage transition(Stage current, Stage requested) {
        if (requested == null) return current;
        if (requested == Stage.VERIFIED_ENABLED || requested == Stage.DEMONSTRATED) {
            throw new IllegalArgumentException("Live verification is required for success");
        }
        return requested;
    }

    private static boolean isLiveEnabled(Capability capability, LiveState live) {
        return switch (capability) {
            case CONNECTION -> live.connected;
            case MICROPHONE -> live.microphone;
            case FIRST_CONVERSATION -> live.conversationCompleted;
            case NOTIFICATIONS -> live.notifications;
            default -> false;
        };
    }
}
