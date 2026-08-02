package ag.companion;

import android.content.res.XmlResourceParser;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.xmlpull.v1.XmlPullParser;

import java.util.LinkedHashMap;
import java.util.Map;

import static org.junit.Assert.assertEquals;

@RunWith(RobolectricTestRunner.class)
public final class MoaLauncherShortcutsTest {
    private static final String ANDROID_NS = "http://schemas.android.com/apk/res/android";

    @Test
    public void longPressMenuExposesEveryTypedInvocation() throws Exception {
        Map<String, String> actions = new LinkedHashMap<>();
        try (XmlResourceParser parser =
                     org.robolectric.RuntimeEnvironment.getApplication()
                             .getResources().getXml(R.xml.shortcuts)) {
            String shortcutId = "";
            while (parser.next() != XmlPullParser.END_DOCUMENT) {
                if (parser.getEventType() == XmlPullParser.START_TAG
                        && "shortcut".equals(parser.getName())) {
                    shortcutId = parser.getAttributeValue(ANDROID_NS, "shortcutId");
                } else if (parser.getEventType() == XmlPullParser.START_TAG
                        && "intent".equals(parser.getName())) {
                    actions.put(shortcutId, parser.getAttributeValue(ANDROID_NS, "action"));
                }
            }
        }

        assertEquals(4, actions.size());
        assertEquals(MoaInvocationResolver.ACTION_DICTATION, actions.get("dictation"));
        assertEquals(MoaInvocationResolver.ACTION_ASSISTANT, actions.get("assistant"));
        assertEquals(MoaInvocationResolver.ACTION_HANDS_FREE, actions.get("hands_free"));
        assertEquals(MoaInvocationResolver.ACTION_CONTROL_CENTER, actions.get("control_center"));
    }
}
