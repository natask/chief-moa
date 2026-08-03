package ag.companion;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.text.InputType;
import android.view.inputmethod.EditorInfo;

import org.junit.Test;

public final class MoaImeEditorPolicyTest {
    @Test
    public void passwordVariantsFailClosed() {
        assertTrue(MoaImeEditorPolicy.isSensitive(null));
        assertTrue(MoaImeEditorPolicy.isSensitive(editor(
                InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD)));
        assertTrue(MoaImeEditorPolicy.isSensitive(editor(
                InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD)));
        assertTrue(MoaImeEditorPolicy.isSensitive(editor(
                InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD)));
        assertTrue(MoaImeEditorPolicy.isSensitive(editor(
                InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_VARIATION_PASSWORD)));
        assertFalse(MoaImeEditorPolicy.isSensitive(editor(
                InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS)));
    }

    @Test
    public void bindingRejectsFocusAndEditorIdentityChanges() {
        EditorInfo original = editor(InputType.TYPE_CLASS_TEXT);
        original.packageName = "example.notes";
        original.fieldId = 7;
        original.imeOptions = EditorInfo.IME_ACTION_DONE;
        MoaImeEditorPolicy.EditorBinding binding = MoaImeEditorPolicy.bind(original, 4L);
        assertNotNull(binding);
        assertTrue(binding.matches(original, 4L));
        assertFalse(binding.matches(original, 5L));

        EditorInfo changed = editor(InputType.TYPE_CLASS_TEXT);
        changed.packageName = "example.notes";
        changed.fieldId = 8;
        changed.imeOptions = EditorInfo.IME_ACTION_DONE;
        assertFalse(binding.matches(changed, 4L));
        assertNull(MoaImeEditorPolicy.bind(
                editor(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD), 5L));
    }

    private static EditorInfo editor(int inputType) {
        EditorInfo editor = new EditorInfo();
        editor.inputType = inputType;
        editor.packageName = "example.app";
        editor.fieldId = 1;
        return editor;
    }
}
