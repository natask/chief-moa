package ai.moa.assistant;

enum VoiceRuntimeState {
    READY,
    LISTENING,
    SENDING,
    THINKING,
    SPEAKING,
    INTERRUPTED,
    RECOVERING,
    ERROR
}
