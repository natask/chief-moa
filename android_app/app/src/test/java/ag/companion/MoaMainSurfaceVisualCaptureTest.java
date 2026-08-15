package ag.companion;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.view.View;
import android.view.ViewGroup;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.GraphicsMode;

import java.io.File;
import java.io.FileOutputStream;

import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

@RunWith(RobolectricTestRunner.class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = 35)
public final class MoaMainSurfaceVisualCaptureTest {
    @Test
    @Config(qualifiers = "w360dp-h800dp-xxhdpi")
    public void capturesCompactPhoneAtRealDensity() throws Exception {
        captureProfile("360x800", 1080, 2400);
    }

    @Test
    @Config(qualifiers = "w412dp-h915dp-xhdpi")
    public void capturesLargePhoneAtRealDensity() throws Exception {
        captureProfile("412x915", 824, 1830);
    }

    private static void captureProfile(String profile, int width, int height) throws Exception {
        File output = new File(System.getProperty("moa.visual.output", "build/visual-qa"));
        assertTrue(output.mkdirs() || output.isDirectory());
        captureDestination(output, profile, "talk", "Talk", width, height);
        captureDestination(output, profile, "work", "Work", width, height);
        captureDestination(output, profile, "releases", "Releases", width, height);
        captureDestination(output, profile, "settings", "Settings", width, height);
    }

    private static void captureDestination(File output, String profile, String name,
            String destination, int width, int height) throws Exception {
        MainActivity activity = Robolectric.buildActivity(MainActivity.class).create().get();
        View root = activity.findViewById(android.R.id.content);
        select(root, destination);
        assertNotNull(findDestination(root, "Talk"));
        assertNotNull(findDestination(root, "Work"));
        assertNotNull(findDestination(root, "Releases"));
        assertNotNull(findDestination(root, "Settings"));
        capture(root, new File(output, "android-" + profile + "-" + name + ".png"), width, height);
        activity.finish();
    }

    private static void select(View root, String label) {
        View destination = findDestination(root, label);
        assertNotNull(destination);
        destination.performClick();
    }

    private static View findDestination(View view, String label) {
        CharSequence description = view.getContentDescription();
        if (description != null && description.toString().startsWith(label + ",")) return view;
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int index = 0; index < group.getChildCount(); index++) {
                View found = findDestination(group.getChildAt(index), label);
                if (found != null) return found;
            }
        }
        return null;
    }

    private static void capture(View root, File destination, int width, int height) throws Exception {
        root.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY));
        root.layout(0, 0, width, height);
        Bitmap bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bitmap);
        root.draw(canvas);
        root.invalidate();
        root.draw(canvas);
        try (FileOutputStream stream = new FileOutputStream(destination)) {
            assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream));
        }
    }
}
