package ag.companion;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import android.app.Application;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.os.Looper;
import android.view.View;
import android.view.accessibility.AccessibilityNodeInfo;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.GraphicsMode;

import java.io.File;
import java.io.FileOutputStream;
import java.time.Duration;
import java.util.concurrent.atomic.AtomicInteger;

/** Deterministic visual evidence rendered by the production Android views. */
@RunWith(RobolectricTestRunner.class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = 35)
public final class MoaOverlayVisualCaptureTest {
    private static final int CANVAS_W = 1080;
    private static final int CANVAS_H = 720;

    @Test
    public void captureCollapsedStreamingAndExpandedTranscript() throws Exception {
        File output = new File(System.getProperty("moa.visual.output", "build/visual-qa"));
        assertTrue(output.mkdirs() || output.isDirectory());

        Bitmap collapsed = render(false);
        Bitmap expanded = render(true);
        write(collapsed, new File(output, "android-overlay-collapsed.png"));
        write(expanded, new File(output, "android-overlay-expanded.png"));

        assertEquals(CANVAS_W, collapsed.getWidth());
        assertEquals(CANVAS_H, collapsed.getHeight());
        assertTrue("collapsed capture must contain painted UI", nonBackgroundPixels(collapsed) > 1000);
        assertTrue("expanded capture must differ from collapsed",
                !collapsed.sameAs(expanded));
        assertEquals(36, MoaRibbonTokens.RIBBON_H_DP);
        assertEquals(280, MoaRibbonTokens.RIBBON_MAX_W_DP);
        assertEquals(67, MoaOrbPresentation.scaledWindowDp(MoaPrefs.ORB_SCALE_DEFAULT));
        assertEquals(6, MoaRibbonTokens.GAP_DP);
    }

    @Test
    public void expandedGeometryKeepsCopyAndHistoryInTheBoundedBubble() {
        Application context = RuntimeEnvironment.getApplication();
        MoaRibbonView ribbon = new MoaRibbonView(context, false);
        int width = dp(context, MoaRibbonTokens.RIBBON_MAX_W_DP);
        measure(ribbon, width, ribbon.ribbonHeightPx());
        ribbon.setFullText("A current turn long enough to wrap over several lines while remaining bounded.");
        ribbon.setExpanded(true);
        measure(ribbon, width, ribbon.desiredHeightPx());

        assertTrue(ribbon.desiredHeightPx() > ribbon.ribbonHeightPx());
        assertTrue(ribbon.desiredHeightPx() <= dp(context, MoaRibbonTokens.EXPANDED_MAX_H_DP));
        assertTrue(ribbon.hitsHistory(width - dp(context, 60), ribbon.ribbonHeightPx() / 2f));
        assertTrue(ribbon.hitsRail(width - dp(context, 8), ribbon.ribbonHeightPx() / 2f));
    }

    @Test
    @Config(sdk = 26)
    public void api26ExposesIndependentCopyAndHistoryActions() {
        Application context = RuntimeEnvironment.getApplication();
        MoaRibbonView ribbon = new MoaRibbonView(context, false);
        AtomicInteger taps = new AtomicInteger();
        AtomicInteger copies = new AtomicInteger();
        AtomicInteger histories = new AtomicInteger();
        ribbon.setAccessibilityActions(taps::incrementAndGet,
                copies::incrementAndGet, histories::incrementAndGet);
        ribbon.setFullText("A retained user message");

        AccessibilityNodeInfo info = AccessibilityNodeInfo.obtain();
        ribbon.onInitializeAccessibilityNodeInfo(info);
        int copyAction = actionId(info, "Copy");
        int historyAction = actionId(info, "History");

        assertTrue(copyAction != 0);
        assertTrue(historyAction != 0);
        assertTrue(ribbon.performAccessibilityAction(copyAction, null));
        assertTrue(ribbon.performAccessibilityAction(historyAction, null));
        assertTrue(ribbon.performAccessibilityAction(AccessibilityNodeInfo.ACTION_CLICK, null));
        assertEquals(1, copies.get());
        assertEquals(1, histories.get());
        assertEquals(1, taps.get());
        info.recycle();
    }

    private static int actionId(AccessibilityNodeInfo info, String label) {
        for (AccessibilityNodeInfo.AccessibilityAction action : info.getActionList()) {
            if (label.contentEquals(action.getLabel())) return action.getId();
        }
        return 0;
    }

    private Bitmap render(boolean expanded) {
        Application context = RuntimeEnvironment.getApplication();
        Bitmap bitmap = Bitmap.createBitmap(CANVAS_W, CANVAS_H, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bitmap);
        drawPhoneBackdrop(canvas);

        MoaRibbonView ribbon = new MoaRibbonView(context, false);
        ribbon.setPalette(MoaRibbonTokens.DARK);
        int ribbonWidth = dp(context, MoaRibbonTokens.RIBBON_MAX_W_DP);
        measure(ribbon, ribbonWidth, ribbon.ribbonHeightPx());
        ribbon.setWindowText("This deliberately long streaming hypothesis exceeds the fixed Android viewport and proves that the window slides left while the newest spoken words stay visible at the right edge");
        ribbon.setFullText("I want a small companion with a clear text bubble above it. The transcription should stream through a fixed window so the newest words always remain visible. When I tap the bubble, expand the complete current turn without turning the overlay into a full chat panel.");
        ribbon.setPresenceState(expanded ? MoaRibbonPresence.State.ENGAGED : MoaRibbonPresence.State.AMBIENT);
        Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(500));
        ribbon.setCaretVisible(false);
        ribbon.setExpanded(expanded);
        int ribbonHeight = ribbon.desiredHeightPx();
        measure(ribbon, ribbonWidth, ribbonHeight);

        OrbView orb = new OrbView(context);
        int companion = dp(context, MoaOrbPresentation.scaledWindowDp(MoaPrefs.ORB_SCALE_DEFAULT));
        measure(orb, companion, companion);

        int ribbonX = (CANVAS_W - ribbonWidth) / 2;
        int ribbonY = expanded ? 82 : 220;
        canvas.save();
        canvas.translate(ribbonX, ribbonY);
        ribbon.draw(canvas);
        canvas.restore();

        canvas.save();
        canvas.translate((CANVAS_W - companion) / 2f, ribbonY + ribbonHeight + dp(context, MoaRibbonTokens.GAP_DP));
        orb.draw(canvas);
        canvas.restore();
        return bitmap;
    }

    private static void measure(View view, int width, int height) {
        view.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY));
        view.layout(0, 0, width, height);
    }

    private static void drawPhoneBackdrop(Canvas canvas) {
        canvas.drawColor(Color.rgb(28, 30, 36));
    }

    private static int nonBackgroundPixels(Bitmap bitmap) {
        int background = Color.rgb(28, 30, 36);
        int count = 0;
        for (int y = 0; y < bitmap.getHeight(); y += 2) {
            for (int x = 0; x < bitmap.getWidth(); x += 2) {
                if (bitmap.getPixel(x, y) != background) count++;
            }
        }
        return count;
    }

    private static void write(Bitmap bitmap, File file) throws Exception {
        try (FileOutputStream stream = new FileOutputStream(file)) {
            assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream));
        }
    }

    private static int dp(Application context, int value) {
        return Math.round(value * context.getResources().getDisplayMetrics().density);
    }
}
