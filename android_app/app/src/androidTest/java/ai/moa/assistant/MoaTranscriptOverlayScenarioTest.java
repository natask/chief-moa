package ai.moa.assistant;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.app.Instrumentation;
import android.app.UiAutomation;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.graphics.Rect;
import android.os.ParcelFileDescriptor;

import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.runner.AndroidJUnit4;
import androidx.test.uiautomator.By;
import androidx.test.uiautomator.UiDevice;
import androidx.test.uiautomator.UiObject2;
import androidx.test.uiautomator.Until;

import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.FileInputStream;
import java.nio.charset.StandardCharsets;

@RunWith(AndroidJUnit4.class)
public final class MoaTranscriptOverlayScenarioTest {
    static final String PARTIAL = "The transcript arrives immediately";
    static final String FINAL = "The transcript arrives immediately and remains one compact streaming line until I choose to expand it.";
    private UiDevice device;
    private Instrumentation instrumentation;

    @Before
    public void prepare() throws Exception {
        instrumentation = InstrumentationRegistry.getInstrumentation();
        device = UiDevice.getInstance(instrumentation);
        shell("appops set ai.moa.assistant android:system_alert_window allow");
        inject("reset", "");
    }

    @Test
    public void partialFinalExpandedHistoryAndCopy() throws Exception {
        inject("partial", PARTIAL);
        UiObject2 partial = waitForRibbon(PARTIAL);
        Rect collapsedBounds = partial.getVisibleBounds();
        checkpoint("partial");

        inject("final", FINAL);
        UiObject2 finished = waitForRibbon("until I choose to expand it");
        assertTrue(finished.getContentDescription().contains("Copy and History"));
        checkpoint("final");

        Rect bounds = finished.getVisibleBounds();
        finished.click();
        UiObject2 expanded = waitForRibbon("until I choose to expand it");
        assertTrue("expanded ribbon must grow", expanded.getVisibleBounds().height() > collapsedBounds.height());
        checkpoint("expanded");

        bounds = expanded.getVisibleBounds();
        int rail = Math.round(44 * instrumentation.getTargetContext()
                .getResources().getDisplayMetrics().density);
        device.click(bounds.right - rail / 2, bounds.top + Math.min(rail / 2, bounds.height() / 2));
        assertEquals(FINAL, clipboardText());
        checkpoint("copy");

        device.click(bounds.right - rail - rail / 2, bounds.top + Math.min(rail / 2, bounds.height() / 2));
        assertTrue(device.wait(Until.hasObject(By.textContains("Recent shared history")), 5000));
        checkpoint("history");
    }

    private UiObject2 waitForRibbon(String text) {
        UiObject2 node = device.wait(Until.findObject(By.descContains(text)), 5000);
        assertNotNull("missing real overlay ribbon containing: " + text, node);
        return node;
    }

    private void inject(String state, String text) throws Exception {
        shell("am broadcast -a ai.moa.assistant.debug.QA_STATE -p ai.moa.assistant --es state "
                + quote(state) + " --es text " + quote(text));
        device.waitForIdle();
    }

    private void checkpoint(String name) throws Exception {
        shell("mkdir -p /sdcard/Download/moa-qa");
        shell("screencap -p /sdcard/Download/moa-qa/" + name + ".png");
        shell("uiautomator dump /sdcard/Download/moa-qa/" + name + ".xml");
        shell("sh -c \"echo " + name
                + " >> /sdcard/Download/moa-qa/interaction-trace.txt\"");
    }

    private String clipboardText() {
        ClipboardManager manager = (ClipboardManager) instrumentation.getTargetContext()
                .getSystemService(Context.CLIPBOARD_SERVICE);
        ClipData clip = manager.getPrimaryClip();
        assertNotNull(clip);
        return clip.getItemAt(0).coerceToText(instrumentation.getTargetContext()).toString();
    }

    private String shell(String command) throws Exception {
        UiAutomation automation = instrumentation.getUiAutomation();
        try (ParcelFileDescriptor descriptor = automation.executeShellCommand(command);
             FileInputStream input = new FileInputStream(descriptor.getFileDescriptor())) {
            return new String(input.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    private static String quote(String value) {
        return "'" + value.replace("'", "'\\''") + "'";
    }
}
