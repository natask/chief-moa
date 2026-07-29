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
import java.io.FileWriter;
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

        // Expansion state is injected deterministically; real pointer delivery
        // remains exercised below by Copy and History, while existing focused
        // touch-listener tests cover tap-to-expand resolution.
        inject("expand", "");
        Rect expandedBounds = waitForBounds(true);
        assertTrue("expanded ribbon must grow", expandedBounds.height() > collapsedBounds.height());
        checkpoint("expanded");

        bounds = expandedBounds;
        int rail = instrumentation.getTargetContext()
                .getSharedPreferences("moa_qa", Context.MODE_PRIVATE)
                .getInt("rail_width", 0);
        assertTrue("rendered rail width missing", rail > 0);
        device.click(bounds.right - rail / 2, bounds.top + Math.min(rail / 2, bounds.height() / 2));
        assertEquals(FINAL, clipboardText());
        checkpoint("copy");

        long historyBefore = System.currentTimeMillis();
        device.click(bounds.right - rail - rail / 2,
                bounds.top + Math.min(rail / 2, bounds.height() / 2));
        assertTrue("History rail did not invoke the real full-app handoff",
                waitForQaTimestamp("history_opened_at", historyBefore));
        checkpoint("history");
    }

    private void inject(String state, String text) throws Exception {
        Context target = instrumentation.getTargetContext();
        Intent input = new Intent(target, MoaQaStateReceiver.class)
                .putExtra("state", state).putExtra("text", text);
        new MoaQaStateReceiver().onReceive(target, input);
        device.waitForIdle();
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

    private boolean waitForQaTimestamp(String key, long minimum) throws Exception {
        SharedPreferences prefs = instrumentation.getTargetContext()
                .getSharedPreferences("moa_qa", Context.MODE_PRIVATE);
        for (int attempt = 0; attempt < 50; attempt++) {
            if (prefs.getLong(key, 0) >= minimum) return true;
            Thread.sleep(100);
        }
        return false;
    }

    private void checkpoint(String name) throws Exception {
        shell("mkdir -p /sdcard/Download/moa-qa");
        shell("screencap -p /sdcard/Download/moa-qa/" + name + ".png");
        // Reuse instrumentation's UiAutomation connection. Starting the legacy
        // shell dumper here tries to register a second service and crashes the
        // active Android 15 instrumentation process.
        device.dumpWindowHierarchy(new File("/sdcard/Download/moa-qa/" + name + ".xml"));
        try (FileWriter trace = new FileWriter(
                "/sdcard/Download/moa-qa/interaction-trace.txt", true)) {
            trace.write(name + "\n");
        }
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
