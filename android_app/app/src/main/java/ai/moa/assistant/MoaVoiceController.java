package ai.moa.assistant;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;

import java.util.ArrayList;
import java.util.Locale;

final class MoaVoiceController {
    private static final int LISTEN_NONE = 0;
    private static final int LISTEN_COMMAND = 1;

    interface Callback {
        void onVoiceStateChanged();

        void onShowPanelRequested();

        void onAssistantMessage(String text);

        void onShowTranscript(String text);

        void onUpdateTranscript(String text);

        void onRemoveTranscript();

        void onComposerText(String text);

        void onVoiceTurn(String text);

        void onSpokenReplyFinished();
    }

    private final Context context;
    private final Callback callback;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private SpeechRecognizer speechRecognizer;
    private TextToSpeech textToSpeech;
    private boolean ttsReady;
    private boolean listening;
    private boolean ignoreNextSpeechError;
    private boolean restartCommandAfterSpeech;
    private boolean manualCommitOnly;
    private boolean pendingManualCommit;
    private int listenMode = LISTEN_NONE;
    private String liveTranscript = "";
    private String recognitionLanguageTag = Locale.getDefault().toLanguageTag();
    private String replyLanguageTag = Locale.US.toLanguageTag();
    private final MoaSpeechTranscriptAccumulator transcriptAccumulator = new MoaSpeechTranscriptAccumulator();
    private volatile String activeUtteranceId = "";
    private int utteranceSequence;

    MoaVoiceController(Context context, Callback callback) {
        this.context = context;
        this.callback = callback;
        setupTextToSpeech();
        setupSpeechRecognizer();
    }

    void destroy() {
        if (speechRecognizer != null) {
            speechRecognizer.destroy();
            speechRecognizer = null;
        }
        if (textToSpeech != null) {
            activeUtteranceId = "";
            textToSpeech.stop();
            textToSpeech.shutdown();
            textToSpeech = null;
        }
    }

    boolean isCommandListening() {
        return listenMode == LISTEN_COMMAND;
    }

    boolean isIdle() {
        return listenMode == LISTEN_NONE && !listening;
    }

    boolean isActive() {
        return listenMode != LISTEN_NONE || listening;
    }

    void setLanguageTags(String inputLanguageTag, String outputLanguageTag) {
        String input = safe(inputLanguageTag);
        String output = safe(outputLanguageTag);
        recognitionLanguageTag = input.isEmpty() ? Locale.getDefault().toLanguageTag() : input;
        replyLanguageTag = output.isEmpty() ? Locale.US.toLanguageTag() : output;
        applyTextToSpeechLanguage();
    }

    void handlePrimaryTap() {
        if (listenMode == LISTEN_COMMAND) {
            commitCurrentSpeechThenRestart();
            return;
        }
        startCommandListening(false);
    }

    void toggleListening() {
        if (speechRecognizer == null) {
            callback.onAssistantMessage("This Android device does not expose speech recognition. Text chat still works.");
            return;
        }

        if (!hasMicPermission()) {
            callback.onAssistantMessage("Microphone permission is missing. Open the Aggie app and enable microphone access first.");
            return;
        }

        if (listenMode == LISTEN_COMMAND) {
            stopActiveListening();
            liveTranscript = "";
            callback.onRemoveTranscript();
            return;
        }

        startCommandListening(false);
    }

    void startCommandListening() {
        startCommandListening(false);
    }

    void startCommandListening(boolean manualCommitOnly) {
        if (speechRecognizer == null) {
            callback.onShowPanelRequested();
            callback.onAssistantMessage("This Android device does not expose speech recognition. Text chat still works.");
            return;
        }
        if (!hasMicPermission()) {
            callback.onShowPanelRequested();
            callback.onAssistantMessage("Microphone permission is missing. Open the Aggie app and enable microphone access first.");
            return;
        }
        liveTranscript = "";
        transcriptAccumulator.reset();
        this.manualCommitOnly = manualCommitOnly;
        pendingManualCommit = false;
        callback.onComposerText("");
        listenMode = LISTEN_COMMAND;
        listening = true;
        callback.onShowTranscript("");
        callback.onVoiceStateChanged();
        try {
            speechRecognizer.startListening(newSpeechIntent());
        } catch (RuntimeException error) {
            listening = false;
            listenMode = LISTEN_NONE;
            this.manualCommitOnly = false;
            pendingManualCommit = false;
            liveTranscript = "";
            transcriptAccumulator.reset();
            callback.onVoiceStateChanged();
            callback.onRemoveTranscript();
            callback.onAssistantMessage("Voice could not start: " + cleanError(error) + ".");
        }
    }

    void commitCurrentSpeech() {
        if (speechRecognizer == null || listenMode != LISTEN_COMMAND) {
            startCommandListening(false);
            return;
        }

        restartCommandAfterSpeech = false;
        pendingManualCommit = manualCommitOnly;
        listening = false;
        callback.onVoiceStateChanged();
        try {
            speechRecognizer.stopListening();
        } catch (RuntimeException error) {
            finishCommandTurn(liveTranscript);
        }
        if (manualCommitOnly) {
            mainHandler.postDelayed(() -> {
                if (pendingManualCommit && listenMode == LISTEN_COMMAND) {
                    finishCommandTurn(liveTranscript);
                }
            }, 450);
        }
    }

    void stopQuietly() {
        restartCommandAfterSpeech = false;
        manualCommitOnly = false;
        pendingManualCommit = false;
        liveTranscript = "";
        transcriptAccumulator.reset();
        callback.onComposerText("");
        activeUtteranceId = "";
        if (textToSpeech != null) {
            textToSpeech.stop();
        }
        if (speechRecognizer != null && listenMode != LISTEN_NONE) {
            ignoreNextSpeechError = true;
            speechRecognizer.cancel();
        }
        listening = false;
        listenMode = LISTEN_NONE;
        callback.onVoiceStateChanged();
        callback.onRemoveTranscript();
    }

    boolean speak(String text) {
        String value = safe(text);
        if (value.isEmpty() || !ttsReady || textToSpeech == null) {
            return false;
        }
        String utteranceId = "moa-reply-" + (++utteranceSequence);
        activeUtteranceId = utteranceId;
        int result = textToSpeech.speak(value, TextToSpeech.QUEUE_FLUSH, null, utteranceId);
        if (result == TextToSpeech.ERROR) {
            activeUtteranceId = "";
            return false;
        }
        return true;
    }

    private void setupSpeechRecognizer() {
        if (!SpeechRecognizer.isRecognitionAvailable(context)) {
            return;
        }

        speechRecognizer = SpeechRecognizer.createSpeechRecognizer(context);
        speechRecognizer.setRecognitionListener(new RecognitionListener() {
            @Override
            public void onReadyForSpeech(Bundle params) {
                listening = true;
                callback.onVoiceStateChanged();
            }

            @Override
            public void onBeginningOfSpeech() {
            }

            @Override
            public void onRmsChanged(float rmsdB) {
            }

            @Override
            public void onBufferReceived(byte[] buffer) {
            }

            @Override
            public void onEndOfSpeech() {
                listening = false;
                callback.onVoiceStateChanged();
            }

            @Override
            public void onError(int error) {
                int mode = listenMode;
                listening = false;
                if (mode == LISTEN_COMMAND && manualCommitOnly && pendingManualCommit) {
                    finishCommandTurn(liveTranscript);
                    return;
                }
                if (mode == LISTEN_COMMAND && manualCommitOnly && isQuietSpeechError(error)) {
                    callback.onVoiceStateChanged();
                    return;
                }
                listenMode = LISTEN_NONE;
                manualCommitOnly = false;
                pendingManualCommit = false;
                callback.onVoiceStateChanged();
                if (ignoreNextSpeechError) {
                    ignoreNextSpeechError = false;
                    if (mode == LISTEN_COMMAND && restartCommandAfterSpeech) {
                        finishCommandTurn("");
                    }
                    return;
                }
                if (mode == LISTEN_COMMAND && restartCommandAfterSpeech) {
                    finishCommandTurn("");
                    return;
                }
                callback.onRemoveTranscript();
                if (mode == LISTEN_COMMAND && isQuietSpeechError(error)) {
                    liveTranscript = "";
                    transcriptAccumulator.reset();
                    return;
                }
                callback.onAssistantMessage("Voice stopped: " + speechError(error) + ". You can still type here.");
            }

            @Override
            public void onResults(Bundle results) {
                int mode = listenMode;
                listening = false;
                String text = firstSpeechResult(results);
                if (mode == LISTEN_COMMAND) {
                    text = transcriptAccumulator.update(text);
                    if (manualCommitOnly && !pendingManualCommit) {
                        if (!text.isEmpty()) {
                            liveTranscript = text;
                            callback.onUpdateTranscript(text);
                            callback.onComposerText(text);
                        }
                        callback.onVoiceStateChanged();
                        return;
                    }
                    listenMode = LISTEN_NONE;
                    callback.onVoiceStateChanged();
                    finishCommandTurn(text);
                    return;
                }
                listenMode = LISTEN_NONE;
                manualCommitOnly = false;
                pendingManualCommit = false;
                callback.onVoiceStateChanged();
            }

            @Override
            public void onPartialResults(Bundle partialResults) {
                String text = transcriptAccumulator.update(firstSpeechResult(partialResults));
                if (!text.isEmpty()) {
                    liveTranscript = text;
                }
                if (listenMode == LISTEN_COMMAND && !text.isEmpty()) {
                    callback.onUpdateTranscript(text);
                    callback.onComposerText(text);
                    if (isStopCommand(text)) {
                        stopQuietly();
                    }
                }
            }

            @Override
            public void onEvent(int eventType, Bundle params) {
            }
        });
    }

    private void finishCommandTurn(String recognizedText) {
        boolean restart = restartCommandAfterSpeech;
        restartCommandAfterSpeech = false;
        manualCommitOnly = false;
        pendingManualCommit = false;
        listening = false;
        listenMode = LISTEN_NONE;
        callback.onVoiceStateChanged();

        String text = safe(recognizedText);
        if (text.isEmpty()) {
            text = safe(liveTranscript);
        }
        text = transcriptAccumulator.update(text);
        liveTranscript = "";
        transcriptAccumulator.reset();
        callback.onComposerText("");

        if (isStopCommand(text)) {
            stopQuietly();
            return;
        }

        if (!text.isEmpty()) {
            callback.onVoiceTurn(text);
        }

        if (restart) {
            callback.onShowTranscript("");
            mainHandler.postDelayed(this::startCommandListening, 260);
            return;
        }

        if (text.isEmpty()) {
            callback.onRemoveTranscript();
        }
    }

    private void commitCurrentSpeechThenRestart() {
        if (speechRecognizer == null || listenMode != LISTEN_COMMAND) {
            startCommandListening(false);
            return;
        }

        restartCommandAfterSpeech = true;
        pendingManualCommit = false;
        listening = false;
        callback.onVoiceStateChanged();
        try {
            speechRecognizer.stopListening();
        } catch (RuntimeException error) {
            finishCommandTurn(liveTranscript);
        }
    }

    private void stopActiveListening() {
        if (speechRecognizer != null && listenMode != LISTEN_NONE) {
            ignoreNextSpeechError = true;
            speechRecognizer.cancel();
        }
        listening = false;
        listenMode = LISTEN_NONE;
        manualCommitOnly = false;
        pendingManualCommit = false;
        liveTranscript = "";
        transcriptAccumulator.reset();
        callback.onVoiceStateChanged();
    }

    private Intent newSpeechIntent() {
        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, recognitionLanguageTag);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, recognitionLanguageTag);
        intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
        intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS, 700L);
        intent.putExtra(
                RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS,
                manualCommitOnly ? 60000L : 850L
        );
        intent.putExtra(
                RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS,
                manualCommitOnly ? 60000L : 450L
        );
        return intent;
    }

    private void setupTextToSpeech() {
        textToSpeech = new TextToSpeech(context, status -> {
            ttsReady = status == TextToSpeech.SUCCESS;
            if (ttsReady) {
                applyTextToSpeechLanguage();
                textToSpeech.setPitch(0.88f);
                textToSpeech.setSpeechRate(1.02f);
                textToSpeech.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                    @Override
                    public void onStart(String utteranceId) {
                    }

                    @Override
                    public void onDone(String utteranceId) {
                        finishUtterance(utteranceId);
                    }

                    @Override
                    public void onError(String utteranceId) {
                        finishUtterance(utteranceId);
                    }

                    @Override
                    public void onStop(String utteranceId, boolean interrupted) {
                        finishUtterance(utteranceId);
                    }
                });
            }
        });
    }

    private void applyTextToSpeechLanguage() {
        if (!ttsReady || textToSpeech == null) {
            return;
        }
        Locale locale = Locale.forLanguageTag(replyLanguageTag);
        if (locale == null || locale.getLanguage().isEmpty()) {
            locale = Locale.US;
        }
        int result = textToSpeech.setLanguage(locale);
        if (result == TextToSpeech.LANG_MISSING_DATA || result == TextToSpeech.LANG_NOT_SUPPORTED) {
            textToSpeech.setLanguage(Locale.US);
        }
    }

    private void finishUtterance(String utteranceId) {
        if (utteranceId == null || !utteranceId.equals(activeUtteranceId)) {
            return;
        }
        activeUtteranceId = "";
        mainHandler.post(callback::onSpokenReplyFinished);
    }

    private boolean hasMicPermission() {
        return context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean isStopCommand(String text) {
        String normalized = normalizeSpeech(text);
        return normalized.equals("stop")
                || normalized.equals("stop talking")
                || normalized.equals("stop speaking")
                || normalized.equals("cancel")
                || normalized.equals("never mind")
                || normalized.equals("nevermind");
    }

    private boolean isQuietSpeechError(int error) {
        return error == SpeechRecognizer.ERROR_NO_MATCH
                || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT
                || error == SpeechRecognizer.ERROR_CLIENT;
    }

    private String firstSpeechResult(Bundle bundle) {
        ArrayList<String> results = bundle.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        if (results == null || results.isEmpty()) {
            return "";
        }
        return results.get(0).trim();
    }

    private String speechError(int error) {
        switch (error) {
            case SpeechRecognizer.ERROR_AUDIO:
                return "audio capture error";
            case SpeechRecognizer.ERROR_CLIENT:
                return "client error";
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS:
                return "microphone permission missing";
            case SpeechRecognizer.ERROR_NETWORK:
                return "network error";
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT:
                return "network timeout";
            case SpeechRecognizer.ERROR_NO_MATCH:
                return "no speech matched";
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY:
                return "recognizer busy";
            case SpeechRecognizer.ERROR_SERVER:
                return "speech server error";
            case SpeechRecognizer.ERROR_SPEECH_TIMEOUT:
                return "speech timeout";
            default:
                return "unknown error";
        }
    }

    private String normalizeSpeech(String value) {
        return safe(value)
                .toLowerCase(Locale.US)
                .replaceAll("[^a-z0-9 ]", " ")
                .replaceAll("\\s+", " ")
                .trim();
    }

    private String safe(String value) {
        return value == null ? "" : value.trim();
    }

    private String cleanError(Throwable error) {
        String message = error.getMessage();
        if (message == null || message.trim().isEmpty()) {
            message = error.getClass().getSimpleName();
        }
        message = message.replace('\n', ' ').replace('\r', ' ').trim();
        if (message.length() > 180) {
            return message.substring(0, 180);
        }
        return message;
    }
}
