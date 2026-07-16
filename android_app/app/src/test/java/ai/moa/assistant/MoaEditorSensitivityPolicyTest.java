package ai.moa.assistant;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

import android.text.InputType;
import android.view.inputmethod.EditorInfo;

import org.junit.Test;

public final class MoaEditorSensitivityPolicyTest {
    @Test
    public void nullAndMissingPackageFailClosed() {
        assertEquals(
                MoaEditorSensitivityPolicy.Classification.UNSUPPORTED,
                MoaEditorSensitivityPolicy.classify(null)
        );
        assertTrue(MoaEditorSensitivityPolicy.isSensitive(editor("", InputType.TYPE_CLASS_TEXT, 0)));
    }

    @Test
    public void everyPlatformPasswordVariationIsBlocked() {
        int[] textPasswords = {
                InputType.TYPE_TEXT_VARIATION_PASSWORD,
                InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD,
                InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD
        };
        for (int variation : textPasswords) {
            assertEquals(
                    MoaEditorSensitivityPolicy.Classification.PASSWORD,
                    MoaEditorSensitivityPolicy.classify(editor(
                            "com.example", InputType.TYPE_CLASS_TEXT | variation, 0))
            );
        }
        assertEquals(
                MoaEditorSensitivityPolicy.Classification.PASSWORD,
                MoaEditorSensitivityPolicy.classify(editor(
                        "com.example",
                        InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_VARIATION_PASSWORD,
                        0))
        );
    }

    @Test
    public void ordinarySupportedEditorsRemainAvailable() {
        int[] supported = {
                InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS,
                InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_VARIATION_NORMAL,
                InputType.TYPE_CLASS_PHONE,
                InputType.TYPE_CLASS_DATETIME | InputType.TYPE_DATETIME_VARIATION_DATE
        };
        for (int inputType : supported) {
            MoaEditorSensitivityPolicy.EditorIdentity editor = editor("com.example", inputType, 0);
            assertEquals(
                    MoaEditorSensitivityPolicy.Classification.ORDINARY,
                    MoaEditorSensitivityPolicy.classify(editor)
            );
            assertFalse(MoaEditorSensitivityPolicy.isSensitive(editor));
        }
    }

    @Test
    public void unsupportedAndPrivateEditorsFailClosed() {
        assertEquals(
                MoaEditorSensitivityPolicy.Classification.UNSUPPORTED,
                MoaEditorSensitivityPolicy.classify(editor("com.example", InputType.TYPE_NULL, 0))
        );
        assertEquals(
                MoaEditorSensitivityPolicy.Classification.PRIVATE_EDITOR,
                MoaEditorSensitivityPolicy.classify(editor(
                        "com.example",
                        InputType.TYPE_CLASS_TEXT,
                        EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING))
        );
    }

    @Test
    public void configuredSensitiveMetadataIsTokenAndCamelCaseAware() {
        String[] markers = {"password", "passwd", "passcode", "pin", "otp", "cvv", "cvc", "secret"};
        for (String marker : markers) {
            assertEquals(
                    MoaEditorSensitivityPolicy.Classification.PRIVATE_EDITOR,
                    MoaEditorSensitivityPolicy.classify(new MoaEditorSensitivityPolicy.EditorIdentity(
                            "com.example", 1, InputType.TYPE_CLASS_TEXT, 0,
                            "account_" + marker, "", ""))
            );
        }
        assertEquals(
                MoaEditorSensitivityPolicy.Classification.PRIVATE_EDITOR,
                MoaEditorSensitivityPolicy.classify(new MoaEditorSensitivityPolicy.EditorIdentity(
                        "com.example", 1, InputType.TYPE_CLASS_TEXT, 0,
                        "oneTimePin", "", ""))
        );
        assertEquals(
                MoaEditorSensitivityPolicy.Classification.PRIVATE_EDITOR,
                MoaEditorSensitivityPolicy.classify(new MoaEditorSensitivityPolicy.EditorIdentity(
                        "com.example", 1, InputType.TYPE_CLASS_TEXT, 0,
                        "", "Enter Secret", "vendor.password=true"))
        );
        assertEquals(
                MoaEditorSensitivityPolicy.Classification.ORDINARY,
                MoaEditorSensitivityPolicy.classify(new MoaEditorSensitivityPolicy.EditorIdentity(
                        "com.example", 1, InputType.TYPE_CLASS_TEXT, 0,
                        "shipping", "Write a message", null))
        );
    }

    @Test
    public void identityUsesAllBoundEditorFields() {
        MoaEditorSensitivityPolicy.EditorIdentity first =
                new MoaEditorSensitivityPolicy.EditorIdentity(
                        "pkg", 1, InputType.TYPE_CLASS_TEXT, 2, "field", "hint", "private");
        MoaEditorSensitivityPolicy.EditorIdentity same =
                new MoaEditorSensitivityPolicy.EditorIdentity(
                        "pkg", 1, InputType.TYPE_CLASS_TEXT, 2, "field", "hint", "private");
        assertEquals(first, first);
        assertEquals(first, same);
        assertEquals(first.hashCode(), same.hashCode());
        assertNotEquals(first, null);
        assertNotEquals(first, "not an editor");
        assertNotEquals(first, editor("other", InputType.TYPE_CLASS_TEXT, 0));
        assertNotEquals(first, new MoaEditorSensitivityPolicy.EditorIdentity(
                "pkg", 2, InputType.TYPE_CLASS_TEXT, 2, "field", "hint", "private"));
        assertNotEquals(first, new MoaEditorSensitivityPolicy.EditorIdentity(
                "pkg", 1, InputType.TYPE_CLASS_NUMBER, 2, "field", "hint", "private"));
        assertNotEquals(first, new MoaEditorSensitivityPolicy.EditorIdentity(
                "pkg", 1, InputType.TYPE_CLASS_TEXT, 3, "field", "hint", "private"));
        assertNotEquals(first, new MoaEditorSensitivityPolicy.EditorIdentity(
                "pkg", 1, InputType.TYPE_CLASS_TEXT, 2, "other", "hint", "private"));
        assertNotEquals(first, new MoaEditorSensitivityPolicy.EditorIdentity(
                "pkg", 1, InputType.TYPE_CLASS_TEXT, 2, "field", "other", "private"));
        assertNotEquals(first, new MoaEditorSensitivityPolicy.EditorIdentity(
                "pkg", 1, InputType.TYPE_CLASS_TEXT, 2, "field", "hint", "other"));
    }

    private MoaEditorSensitivityPolicy.EditorIdentity editor(
            String packageName,
            int inputType,
            int imeOptions
    ) {
        return new MoaEditorSensitivityPolicy.EditorIdentity(
                packageName, 7, inputType, imeOptions, "body", "Message", "");
    }
}
