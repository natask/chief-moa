package ai.moa.assistant;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.app.Instrumentation;
import android.app.UiAutomation;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
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
import java.io.File;
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
        shell("pm grant ai.moa.assistant android.permission.RECORD_AUDIO");
        shell("pm grant ai.moa.assistant android.permission.POST_NOTIFICATIONS");
        shell("appops set ai.moa.assistant android:system_alert_window allow");
        shell("am start -W -n ai.moa.assistant/.MainActivity");
        assertTrue("QA host activity did not become foreground",
                device.wait(Until.hasObject(By.pkg("ai.moa.assistant").depth(0)), 5000));
        inject("reset", "");
    }

    @Test
    public void partialFinalExpandedHistoryAndCopy() throws Exception {
        inject("partial", PARTIAL);
        Rect collapsedBounds = waitForBounds(false);
        checkpoint("partial");

        inject("final", FINAL);
        Rect bounds = waitForBounds(false);
        checkpoint("final");

        Rect expandedBounds = expandThroughUi(bounds);
        assertTrue("expanded ribbon must grow", expandedBounds.height() > collapsedBounds.height());
        checkpoint("expanded");

        bounds = expandedBounds;
        // The rail hit target is one collapsed ribbon high. Reading it from the
        // rendered bounds avoids target/test resource-density disagreement.
        int rail = collapsedBounds.height();
        device.click(bounds.right - rail / 2, bounds.top + Math.min(rail / 2, bounds.height() / 2));
        assertEquals(FINAL, clipboardText());
        checkpoint("copy");

        device.click(bounds.right - rail - rail / 2, bounds.top + Math.min(rail / 2, bounds.height() / 2));
        assertTrue(device.wait(Until.hasObject(By.textContains("Recent shared history")), 5000));
        checkpoint("history");
    }

    private void inject(String state, String text) throws Exception {
        Context target = instrumentation.getTargetContext();
        Intent input = new Intent(target, MoaQaStateReceiver.class)
                .putExtra("state", state).putExtra("text", text);
        new MoaQaStateReceiver().onReceive(target, input);
        device.waitForIdle();
    }

    private Rect expandThroughUi(Rect bounds) throws Exception {
        int[] xs = {bounds.centerX(), bounds.left + bounds.width() / 3,
                bounds.left + bounds.width() * 2 / 3};
        for (int x : xs) {
            device.click(x, bounds.centerY());
            inject("snapshot", "");
            try {
                return waitForBounds(true);
            } catch (AssertionError ignored) {
                // Retry another point inside the rendered text viewport. Rails
                // remain excluded and at least one real UI click is required.
            }
        }
        throw new AssertionError("real ribbon did not expand after UI clicks");
    }

    private Rect waitForBounds(boolean expanded) throws Exception {
        SharedPreferences prefs = instrumentation.getTargetContext()
                .getSharedPreferences("moa_qa", Context.MODE_PRIVATE);
        long before = System.currentTimeMillis();
        for (int attempt = 0; attempt < 30; attempt++) {
            int left = prefs.getInt("left", 0), top = prefs.getInt("top", 0);
            int right = prefs.getInt("right", 0), bottom = prefs.getInt("bottom", 0);
            if (prefs.getLong("observed_at", 0) >= before
                    && prefs.getBoolean("expanded", false) == expanded
                    && right > left && bottom > top) return new Rect(left, top, right, bottom);
            Thread.sleep(100);
        }
        throw new AssertionError("real overlay bounds were not observed; expanded=" + expanded);
    }

    private void checkpoint(String name) throws Exception {
        shell("mkdir -p /sdcard/Download/moa-qa");
        shell("screencap -p /sdcard/Download/moa-qa/" + name + ".png");
        // Reuse instrumentation's UiAutomation connection. Starting the legacy
        // shell dumper here tries to register a second service and crashes the
        // active Android 15 instrumentation process.
        device.dumpWindowHierarchy(new File("/sdcard/Download/moa-qa/" + name + ".xml"));
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

}
