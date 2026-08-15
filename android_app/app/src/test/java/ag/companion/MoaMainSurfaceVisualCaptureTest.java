package ag.companion;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;

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
    private static final int WIDTH = 1080;
    private static final int HEIGHT = 1920;

    @Test public void capturesFourClearProductDestinations() throws Exception {
        MainActivity activity = Robolectric.buildActivity(MainActivity.class).create().get();
        View root = activity.findViewById(android.R.id.content);
        File output = new File(System.getProperty("moa.visual.output", "build/visual-qa"));
        assertTrue(output.mkdirs() || output.isDirectory());

        capture(root, new File(output, "android-main-talk.png"));
        click(root, "Work"); capture(root, new File(output, "android-main-work.png"));
        click(root, "Releases"); capture(root, new File(output, "android-main-releases.png"));
        click(root, "Settings"); capture(root, new File(output, "android-main-settings.png"));

        assertNotNull(find(root, "Talk"));
        assertNotNull(find(root, "Work"));
        assertNotNull(find(root, "Releases"));
        assertNotNull(find(root, "Settings"));
    }

    private static void click(View root, String label) {
        Button button = find(root, label);
        assertNotNull(button);
        button.performClick();
    }

    private static Button find(View view, String label) {
        if (view instanceof Button && label.contentEquals(((Button) view).getText())) return (Button) view;
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int index = 0; index < group.getChildCount(); index++) {
                Button found = find(group.getChildAt(index), label);
                if (found != null) return found;
            }
        }
        return null;
    }

    private static void capture(View root, File destination) throws Exception {
        root.measure(View.MeasureSpec.makeMeasureSpec(WIDTH, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(HEIGHT, View.MeasureSpec.EXACTLY));
        root.layout(0, 0, WIDTH, HEIGHT);
        Bitmap bitmap = Bitmap.createBitmap(WIDTH, HEIGHT, Bitmap.Config.ARGB_8888);
        root.draw(new Canvas(bitmap));
        try (FileOutputStream stream = new FileOutputStream(destination)) {
            assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream));
        }
    }
}
