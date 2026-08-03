package ag.companion;

import android.text.InputType;
import android.view.inputmethod.EditorInfo;

/** Fail-closed editor classification for the voice input surface. */
final class MoaImeEditorPolicy {
    private MoaImeEditorPolicy() {
    }

    static boolean isSensitive(EditorInfo editor) {
        if (editor == null) return true;
        int inputType = editor.inputType;
        int inputClass = inputType & InputType.TYPE_MASK_CLASS;
        int variation = inputType & InputType.TYPE_MASK_VARIATION;
        if (inputClass == InputType.TYPE_CLASS_TEXT) {
            return variation == InputType.TYPE_TEXT_VARIATION_PASSWORD
                    || variation == InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
                    || variation == InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD;
        }
        return inputClass == InputType.TYPE_CLASS_NUMBER
                && variation == InputType.TYPE_NUMBER_VARIATION_PASSWORD;
    }

    static EditorBinding bind(EditorInfo editor, long generation) {
        if (isSensitive(editor) || generation <= 0L) return null;
        return new EditorBinding(
                generation,
                safe(editor.packageName),
                editor.fieldId,
                editor.inputType,
                editor.imeOptions);
    }

    static final class EditorBinding {
        final long generation;
        private final String packageName;
        private final int fieldId;
        private final int inputType;
        private final int imeOptions;

        private EditorBinding(long generation, String packageName, int fieldId,
                int inputType, int imeOptions) {
            this.generation = generation;
            this.packageName = packageName;
            this.fieldId = fieldId;
            this.inputType = inputType;
            this.imeOptions = imeOptions;
        }

        boolean matches(EditorInfo editor, long currentGeneration) {
            return currentGeneration == generation
                    && !isSensitive(editor)
                    && packageName.equals(safe(editor.packageName))
                    && fieldId == editor.fieldId
                    && inputType == editor.inputType
                    && imeOptions == editor.imeOptions;
        }
    }

    private static String safe(String value) {
        return value == null ? "" : value;
    }
}
