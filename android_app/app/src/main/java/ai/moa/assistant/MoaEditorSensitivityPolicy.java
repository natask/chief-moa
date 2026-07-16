package ai.moa.assistant;

import android.text.InputType;
import android.view.inputmethod.EditorInfo;

import java.util.Locale;

/** Pure, fail-closed classification for fields the Moa IME must not observe. */
final class MoaEditorSensitivityPolicy {
    enum Classification {
        ORDINARY,
        PASSWORD,
        PRIVATE_EDITOR,
        UNSUPPORTED
    }

    private MoaEditorSensitivityPolicy() {
    }

    static Classification classify(EditorIdentity editor) {
        if (editor == null || editor.packageName.isEmpty()) {
            return Classification.UNSUPPORTED;
        }

        int inputClass = editor.inputType & InputType.TYPE_MASK_CLASS;
        int variation = editor.inputType & InputType.TYPE_MASK_VARIATION;
        if (inputClass == InputType.TYPE_CLASS_TEXT
                && (variation == InputType.TYPE_TEXT_VARIATION_PASSWORD
                || variation == InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
                || variation == InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD)) {
            return Classification.PASSWORD;
        }
        if (inputClass == InputType.TYPE_CLASS_NUMBER
                && variation == InputType.TYPE_NUMBER_VARIATION_PASSWORD) {
            return Classification.PASSWORD;
        }
        if (inputClass != InputType.TYPE_CLASS_TEXT
                && inputClass != InputType.TYPE_CLASS_NUMBER
                && inputClass != InputType.TYPE_CLASS_PHONE
                && inputClass != InputType.TYPE_CLASS_DATETIME) {
            return Classification.UNSUPPORTED;
        }
        if ((editor.imeOptions & EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING) != 0
                || containsSensitiveMarker(editor.fieldName)
                || containsSensitiveMarker(editor.hintText)
                || containsSensitiveMarker(editor.privateImeOptions)) {
            return Classification.PRIVATE_EDITOR;
        }
        return Classification.ORDINARY;
    }

    static boolean isSensitive(EditorIdentity editor) {
        return classify(editor) != Classification.ORDINARY;
    }

    private static boolean containsSensitiveMarker(String value) {
        if (value == null || value.isEmpty()) {
            return false;
        }
        String withCamelBoundaries = value.replaceAll("([a-z0-9])([A-Z])", "$1 $2");
        String[] tokens = withCamelBoundaries.toLowerCase(Locale.ROOT).split("[^a-z0-9]+");
        for (String token : tokens) {
            if (token.equals("password")
                    || token.equals("passwd")
                    || token.equals("passcode")
                    || token.equals("pin")
                    || token.equals("otp")
                    || token.equals("cvv")
                    || token.equals("cvc")
                    || token.equals("secret")) {
                return true;
            }
        }
        return false;
    }

    static final class EditorIdentity {
        final String packageName;
        final int fieldId;
        final int inputType;
        final int imeOptions;
        final String fieldName;
        final String hintText;
        final String privateImeOptions;

        EditorIdentity(
                String packageName,
                int fieldId,
                int inputType,
                int imeOptions,
                String fieldName,
                String hintText,
                String privateImeOptions
        ) {
            this.packageName = safe(packageName);
            this.fieldId = fieldId;
            this.inputType = inputType;
            this.imeOptions = imeOptions;
            this.fieldName = safe(fieldName);
            this.hintText = safe(hintText);
            this.privateImeOptions = safe(privateImeOptions);
        }

        static EditorIdentity from(EditorInfo info) {
            if (info == null) {
                return null;
            }
            return new EditorIdentity(
                    info.packageName,
                    info.fieldId,
                    info.inputType,
                    info.imeOptions,
                    info.fieldName,
                    info.hintText == null ? "" : info.hintText.toString(),
                    info.privateImeOptions
            );
        }

        @Override
        public boolean equals(Object other) {
            if (this == other) {
                return true;
            }
            if (!(other instanceof EditorIdentity)) {
                return false;
            }
            EditorIdentity that = (EditorIdentity) other;
            return fieldId == that.fieldId
                    && inputType == that.inputType
                    && imeOptions == that.imeOptions
                    && packageName.equals(that.packageName)
                    && fieldName.equals(that.fieldName)
                    && hintText.equals(that.hintText)
                    && privateImeOptions.equals(that.privateImeOptions);
        }

        @Override
        public int hashCode() {
            int result = packageName.hashCode();
            result = 31 * result + fieldId;
            result = 31 * result + inputType;
            result = 31 * result + imeOptions;
            result = 31 * result + fieldName.hashCode();
            result = 31 * result + hintText.hashCode();
            result = 31 * result + privateImeOptions.hashCode();
            return result;
        }

        private static String safe(String value) {
            return value == null ? "" : value;
        }
    }
}
