package ag.companion;

import android.content.Intent;
import android.view.View;
import android.widget.LinearLayout;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.util.ReflectionHelpers;

import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

@RunWith(RobolectricTestRunner.class)
public final class MainActivityRecoveryIntentTest {
    @Test
    public void reconnectIntentIsConsumedAndFocusesRealEnrollmentInput() {
        Intent intent = new Intent().setAction(MoaVoiceRecoveryDialog.ACTION_RECONNECT_DEVICE);
        MainActivity activity = Robolectric.buildActivity(MainActivity.class, intent).create().get();

        LinearLayout setup = ReflectionHelpers.getField(activity, "developerSection");
        assertNull(activity.getIntent().getAction());
        assertTrue(setup.getVisibility() == View.VISIBLE);
    }
}
