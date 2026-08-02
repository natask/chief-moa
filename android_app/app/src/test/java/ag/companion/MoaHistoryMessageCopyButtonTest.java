package ag.companion;

import android.app.Application;
import android.content.ClipboardManager;
import android.widget.Button;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;

import static org.junit.Assert.assertEquals;

@RunWith(RobolectricTestRunner.class)
public final class MoaHistoryMessageCopyButtonTest {
    @Test
    public void userButtonCopiesOnlyItsExactMessage() {
        assertExactCopy("YOU", "  user\nmessage  ", "Copy user message");
    }

    @Test
    public void assistantButtonCopiesOnlyItsExactMessage() {
        assertExactCopy("Ag", "assistant\n\nmessage", "Copy assistant message");
    }

    private static void assertExactCopy(String speaker, String text, String description) {
        Application context = RuntimeEnvironment.getApplication();
        ClipboardManager clipboard =
                (ClipboardManager) context.getSystemService(Application.CLIPBOARD_SERVICE);
        Button button = MoaHistoryMessageCopyButton.create(context, speaker, text);

        assertEquals(description, button.getContentDescription().toString());
        button.performClick();

        assertEquals("Copied", button.getText().toString());
        assertEquals(text, clipboard.getPrimaryClip().getItemAt(0).coerceToText(context).toString());
    }
}
