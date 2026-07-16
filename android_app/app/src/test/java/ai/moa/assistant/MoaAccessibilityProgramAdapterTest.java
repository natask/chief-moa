package ai.moa.assistant;

import android.graphics.Rect;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowAccessibilityNodeInfo;
import org.robolectric.shadows.ShadowAccessibilityService;
import org.robolectric.shadows.ShadowAccessibilityWindowInfo;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.ArrayList;

import static org.junit.Assert.*;
import static org.robolectric.Shadows.shadowOf;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public final class MoaAccessibilityProgramAdapterTest {
    private MoaAccessibilityService service;
    private AccessibilityNodeInfo root;
    private AccessibilityNodeInfo button;
    private AccessibilityNodeInfo editor;

    @Before public void setUp() {
        service = Robolectric.buildService(MoaAccessibilityService.class).create().get();
        root = node("android.widget.FrameLayout", "Root", false, false, false, false);
        button = node("android.widget.Button", "Continue", true, false, false, false);
        editor = node("android.widget.EditText", "private draft", false, true, false, false);
        AccessibilityNodeInfo password = node("android.widget.EditText", "secret", false, true, false, true);
        AccessibilityNodeInfo scroller = node("android.widget.ScrollView", "More", false, false, true, false);
        shadowOf(root).addChild(button);
        shadowOf(root).addChild(editor);
        shadowOf(root).addChild(password);
        shadowOf(root).addChild(scroller);
        installWindow(root, 7, "com.example.fixture");
        MoaAccessibilityProgramAdapter.connect(service);
    }

    @After public void tearDown() {
        MoaAccessibilityProgramAdapter.disconnect(service);
    }

    @Test public void observesRedactsFindsAndBindsOnlyTheLiveWindow() throws Exception {
        JSONObject observation = MoaAccessibilityProgramAdapter.currentObservation();
        assertNotNull(observation);
        assertEquals("com.example.fixture", observation.getString("expected_package"));
        assertEquals("7", observation.getString("window_id"));
        assertEquals(5, observation.getJSONArray("nodes").length());
        assertEquals("[redacted]", observation.getJSONArray("nodes").getJSONObject(3).getString("label"));
        assertEquals("", observation.getJSONArray("nodes").getJSONObject(2).getString("label"));
        assertEquals(new JSONArray().put("click").toString(), observation.getJSONArray("nodes").getJSONObject(1).getJSONArray("actions").toString());

        JSONObject binding = MoaAccessibilityProgramAdapter.currentBinding();
        assertEquals(observation.getString("observation_id"), binding.getString("observation_id"));
        MoaSurfaceProgramContract.Proposal proposal = proposal(binding);
        assertTrue(MoaAccessibilityProgramAdapter.bindingMatches(proposal));
        assertTrue(MoaAccessibilityProgramAdapter.targetMatches(proposal));
        assertEquals(observation.getString("observation_id"), MoaAccessibilityProgramAdapter.boundObservation(proposal).getString("observation_id"));

        JSONObject find = MoaAccessibilityProgramAdapter.find(new JSONObject()
                .put("observation_id", observation.getString("observation_id"))
                .put("observation_digest", observation.getString("observation_digest"))
                .put("query", "CONT"));
        assertEquals(1, find.getJSONArray("nodes").length());
        JSONObject all = MoaAccessibilityProgramAdapter.find(new JSONObject()
                .put("observation_id", observation.getString("observation_id"))
                .put("observation_digest", observation.getString("observation_digest"))
                .put("label", ""));
        assertEquals(5, all.getJSONArray("nodes").length());
        assertNull(MoaAccessibilityProgramAdapter.find(new JSONObject()));

        installWindow(root, 8, "com.other");
        assertFalse(MoaAccessibilityProgramAdapter.bindingMatches(proposal));
        assertFalse(MoaAccessibilityProgramAdapter.targetMatches(proposal));
        assertNull(MoaAccessibilityProgramAdapter.boundObservation(proposal));
    }

    @Test public void executesBoundNodeAndGlobalActionsWithPostState() throws Exception {
        JSONObject observation = MoaAccessibilityProgramAdapter.currentObservation();
        MoaSurfaceProgramContract.Proposal proposal = proposal(MoaAccessibilityProgramAdapter.currentBinding());
        JSONObject buttonInput = nodeInput(observation, 1);
        JSONObject editorInput = nodeInput(observation, 2).put("text", "updated");

        MoaAccessibilityProgramAdapter.ProgramActionResult clicked = MoaAccessibilityProgramAdapter.execute(
                proposal, MoaScriptExecutionCatalog.CLICK, buttonInput);
        assertEquals("indeterminate", clicked.status);
        assertNull(clicked.postStateSha256);
        assertTrue(shadowOf(button).getPerformedActions().contains(AccessibilityNodeInfo.ACTION_CLICK));

        observation = MoaAccessibilityProgramAdapter.currentObservation();
        proposal = proposal(MoaAccessibilityProgramAdapter.currentBinding());
        editorInput = nodeInput(observation, 2).put("text", "updated");
        MoaAccessibilityProgramAdapter.ProgramActionResult edited = MoaAccessibilityProgramAdapter.execute(
                proposal, MoaScriptExecutionCatalog.SET_TEXT, editorInput);
        assertEquals("indeterminate", edited.status);
        assertTrue(shadowOf(editor).getPerformedActions().contains(AccessibilityNodeInfo.ACTION_SET_TEXT));

        observation = MoaAccessibilityProgramAdapter.currentObservation();
        proposal = proposal(MoaAccessibilityProgramAdapter.currentBinding());
        JSONObject scroll = nodeInput(observation, 4).put("direction", "backward");
        assertEquals("indeterminate", MoaAccessibilityProgramAdapter.execute(proposal, MoaScriptExecutionCatalog.SCROLL, scroll).status);

        proposal = proposal(MoaAccessibilityProgramAdapter.currentBinding());
        assertEquals("indeterminate", MoaAccessibilityProgramAdapter.execute(proposal, MoaScriptExecutionCatalog.BACK, new JSONObject()).status);
        proposal = proposal(MoaAccessibilityProgramAdapter.currentBinding());
        assertEquals("indeterminate", MoaAccessibilityProgramAdapter.execute(proposal, MoaScriptExecutionCatalog.HOME, new JSONObject()).status);
        ShadowAccessibilityService shadowService = shadowOf(service);
        assertTrue(shadowService.getGlobalActionsPerformed().contains(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK));
        assertTrue(shadowService.getGlobalActionsPerformed().contains(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_HOME));
    }

    @Test public void rejectsStaleInvalidChangedAndUnsupportedActions() throws Exception {
        JSONObject observation = MoaAccessibilityProgramAdapter.currentObservation();
        MoaSurfaceProgramContract.Proposal proposal = proposal(MoaAccessibilityProgramAdapter.currentBinding());
        assertEquals("stale_state", MoaAccessibilityProgramAdapter.execute(proposal,
                MoaScriptExecutionCatalog.CLICK, new JSONObject()).status);
        JSONObject input = nodeInput(observation, 1);
        input.put("node_id", "missing");
        assertEquals("stale_state", MoaAccessibilityProgramAdapter.execute(proposal,
                MoaScriptExecutionCatalog.CLICK, input).status);

        input = nodeInput(observation, 1);
        button.setBoundsInScreen(new Rect(1, 1, 50, 50));
        assertEquals("stale_state", MoaAccessibilityProgramAdapter.execute(proposal,
                MoaScriptExecutionCatalog.CLICK, input).status);

        observation = MoaAccessibilityProgramAdapter.currentObservation();
        proposal = proposal(MoaAccessibilityProgramAdapter.currentBinding());
        JSONObject editorInput = nodeInput(observation, 2);
        assertEquals("rejected", MoaAccessibilityProgramAdapter.execute(proposal,
                MoaScriptExecutionCatalog.SET_TEXT, editorInput).status);
        editorInput.put("text", "x".repeat(4097));
        assertEquals("rejected", MoaAccessibilityProgramAdapter.execute(proposal,
                MoaScriptExecutionCatalog.SET_TEXT, editorInput).status);
        assertEquals("rejected", MoaAccessibilityProgramAdapter.execute(proposal,
                "android.accessibility.unknown", nodeInput(observation, 1)).status);

        MoaAccessibilityProgramAdapter.onAccessibilityEvent(service);
        assertFalse(MoaAccessibilityProgramAdapter.bindingMatches(proposal));
        assertEquals("stale_state", MoaAccessibilityProgramAdapter.execute(proposal,
                MoaScriptExecutionCatalog.BACK, new JSONObject()).status);
        MoaAccessibilityProgramAdapter.disconnect(service);
        assertNull(MoaAccessibilityProgramAdapter.currentObservation());
        assertNull(MoaAccessibilityProgramAdapter.currentBinding());
        assertFalse(MoaAccessibilityProgramAdapter.targetMatches(proposal));
    }

    @Test public void lifecycleExpiryBindingFieldsAndWindowFallbackFailClosed() throws Exception {
        JSONObject binding = MoaAccessibilityProgramAdapter.currentBinding();
        assertNotNull(binding);
        for (String key : new String[]{"package_name", "window_id", "observation_id", "state_sha256"}) {
            JSONObject changed = new JSONObject(binding.toString());
            changed.put(key, "state_sha256".equals(key) ? "0".repeat(64) : "other");
            assertFalse(MoaAccessibilityProgramAdapter.bindingMatches(proposal(changed)));
        }
        JSONObject changedGeneration = new JSONObject(binding.toString()).put(
                "observation_generation", binding.getLong("observation_generation") + 1);
        assertFalse(MoaAccessibilityProgramAdapter.bindingMatches(proposal(changedGeneration)));

        MoaSurfaceProgramContract.Proposal live = proposal(binding);
        Field latest = MoaAccessibilityProgramAdapter.class.getDeclaredField("latestObservation");
        latest.setAccessible(true);
        Object cached = latest.get(null);
        Field expires = cached.getClass().getDeclaredField("expiresAtMs");
        expires.setAccessible(true);
        expires.setLong(cached, 0L);
        assertFalse(MoaAccessibilityProgramAdapter.bindingMatches(live));
        assertNull(MoaAccessibilityProgramAdapter.find(new JSONObject()));
        assertNotNull(MoaAccessibilityProgramAdapter.currentBinding());

        MoaAccessibilityProgramAdapter.connect(service);
        installWindow(root, 7, "com.example.fixture", false, true);
        assertNotNull(MoaAccessibilityProgramAdapter.currentObservation());

        MoaAccessibilityService obsolete = Robolectric.buildService(MoaAccessibilityService.class).create().get();
        MoaAccessibilityProgramAdapter.onAccessibilityEvent(obsolete);
        assertNotNull(MoaAccessibilityProgramAdapter.currentBinding());
        MoaAccessibilityProgramAdapter.disconnect(obsolete);
        assertNotNull(MoaAccessibilityProgramAdapter.currentObservation());

        shadowOf(service).setWindows(java.util.List.of());
        MoaAccessibilityProgramAdapter.connect(service);
        assertNull(MoaAccessibilityProgramAdapter.currentObservation());
        root.setPackageName(null);
        installWindow(root, 7, null);
        assertNull(MoaAccessibilityProgramAdapter.currentObservation());

        AccessibilityNodeInfo focusedRoot = node("Root", "focused", false, false, false, false);
        focusedRoot.setPackageName("com.example.fixture");
        AccessibilityWindowInfo empty = AccessibilityWindowInfo.obtain();
        AccessibilityWindowInfo focused = AccessibilityWindowInfo.obtain();
        shadowOf(focused).setId(7); shadowOf(focused).setFocused(true); shadowOf(focused).setRoot(focusedRoot);
        shadowOf(focusedRoot).setAccessibilityWindowInfo(focused);
        shadowOf(service).setWindows(java.util.Arrays.asList(null, empty, focused));
        MoaAccessibilityProgramAdapter.connect(service);
        assertNotNull(MoaAccessibilityProgramAdapter.currentObservation());
    }

    @Test public void actionFailuresDirectionsTextPrivacyAndFindCapAreBounded() throws Exception {
        ShadowAccessibilityNodeInfo shadowButton = shadowOf(button);
        shadowButton.setOnPerformActionListener((action, arguments) -> false);
        JSONObject observation = MoaAccessibilityProgramAdapter.currentObservation();
        MoaSurfaceProgramContract.Proposal proposal = proposal(MoaAccessibilityProgramAdapter.currentBinding());
        assertEquals("failed", MoaAccessibilityProgramAdapter.execute(proposal,
                MoaScriptExecutionCatalog.CLICK, nodeInput(observation, 1)).status);

        shadowButton.setOnPerformActionListener((action, arguments) -> true);
        observation = MoaAccessibilityProgramAdapter.currentObservation();
        proposal = proposal(MoaAccessibilityProgramAdapter.currentBinding());
        assertEquals("indeterminate", MoaAccessibilityProgramAdapter.execute(proposal,
                MoaScriptExecutionCatalog.SCROLL, nodeInput(observation, 4).put("direction", "forward")).status);

        observation = MoaAccessibilityProgramAdapter.currentObservation();
        proposal = proposal(MoaAccessibilityProgramAdapter.currentBinding());
        assertEquals("rejected", MoaAccessibilityProgramAdapter.execute(proposal,
                MoaScriptExecutionCatalog.SET_TEXT, nodeInput(observation, 3).put("text", "secret")).status);
        assertEquals("rejected", MoaAccessibilityProgramAdapter.execute(proposal,
                MoaScriptExecutionCatalog.SET_TEXT, nodeInput(observation, 1).put("text", "not editable")).status);

        AccessibilityNodeInfo manyRoot = node("x".repeat(140), " root\n label ", false, false, false, false);
        manyRoot.setContentDescription("preferred\tlabel");
        for (int i = 0; i < 140; i++) shadowOf(manyRoot).addChild(node("Text", "match " + i, false, false, false, false));
        installWindow(manyRoot, 7, "com.example.fixture");
        MoaAccessibilityProgramAdapter.connect(service);
        JSONObject many = MoaAccessibilityProgramAdapter.currentObservation();
        assertEquals(128, many.getJSONArray("nodes").length());
        assertEquals(120, many.getJSONArray("nodes").getJSONObject(0).getString("role").length());
        assertEquals("preferred label", many.getJSONArray("nodes").getJSONObject(0).getString("label"));
        JSONObject capped = MoaAccessibilityProgramAdapter.find(new JSONObject()
                .put("observation_id", many.getString("observation_id"))
                .put("observation_digest", many.getString("observation_digest"))
                .put("query", "match"));
        assertEquals(24, capped.getJSONArray("nodes").length());
        assertNull(MoaAccessibilityProgramAdapter.find(new JSONObject()
                .put("observation_id", "wrong")
                .put("observation_digest", many.getString("observation_digest"))));
        assertNull(MoaAccessibilityProgramAdapter.find(new JSONObject()
                .put("observation_id", many.getString("observation_id"))
                .put("observation_digest", "0".repeat(64))));
    }

    @Test public void internalBoundsAndGenerationCorruptionRemainFailClosed() throws Exception {
        JSONObject binding = MoaAccessibilityProgramAdapter.currentBinding();
        MoaSurfaceProgramContract.Proposal proposal = proposal(binding);
        Field latest = MoaAccessibilityProgramAdapter.class.getDeclaredField("latestObservation");
        latest.setAccessible(true);
        Object cached = latest.get(null);
        Field bodyField = cached.getClass().getDeclaredField("body"); bodyField.setAccessible(true);
        JSONObject body = (JSONObject) bodyField.get(cached);
        long serviceGeneration = body.getLong("accessibility_service_generation");
        body.put("accessibility_service_generation", serviceGeneration + 1);
        assertFalse(MoaAccessibilityProgramAdapter.bindingMatches(proposal));
        body.put("accessibility_service_generation", serviceGeneration);

        long windowGeneration = body.getLong("window_generation");
        body.put("window_generation", windowGeneration + 1);
        assertFalse(MoaAccessibilityProgramAdapter.bindingMatches(proposal));
        body.put("window_generation", windowGeneration);

        Method collect = MoaAccessibilityProgramAdapter.class.getDeclaredMethod("collectNodes",
                AccessibilityNodeInfo.class, java.util.List.class, JSONArray.class, java.util.List.class, int.class);
        collect.setAccessible(true);
        collect.invoke(null, null, new ArrayList<>(), new JSONArray(), new ArrayList<>(), 0);
        collect.invoke(null, root, new ArrayList<>(), new JSONArray(), new ArrayList<>(), 9);
        ArrayList<Object> full = new ArrayList<>(); for (int i = 0; i < 128; i++) full.add(null);
        collect.invoke(null, root, new ArrayList<>(), new JSONArray(), full, 0);

        Method follow = MoaAccessibilityProgramAdapter.class.getDeclaredMethod("followPath", AccessibilityNodeInfo.class, java.util.List.class);
        follow.setAccessible(true);
        assertNull(follow.invoke(null, root, java.util.List.of(-1)));
        assertNull(follow.invoke(null, root, java.util.List.of(999)));
        Method normalize = MoaAccessibilityProgramAdapter.class.getDeclaredMethod("normalize", String.class);
        normalize.setAccessible(true);
        assertEquals("", normalize.invoke(null, new Object[]{null}));

        shadowOf(service).setWindows(java.util.List.of());
        MoaAccessibilityProgramAdapter.connect(service);
        assertFalse(MoaAccessibilityProgramAdapter.targetMatches(proposal));
    }

    private MoaSurfaceProgramContract.Proposal proposal(JSONObject binding) throws Exception {
        JSONObject envelope = MoaSurfaceProgramContractTest.valid();
        envelope.getJSONObject("target").put("device_id", "android_fixture");
        envelope.put("bindings", binding);
        long now = System.currentTimeMillis();
        envelope.put("issued_at", MoaSurfaceProgramEvents.timestamp(now - 1_000));
        envelope.put("expires_at", MoaSurfaceProgramEvents.timestamp(now + 30_000));
        return MoaSurfaceProgramContract.parse(envelope, "android_fixture", now);
    }

    private static JSONObject nodeInput(JSONObject observation, int index) throws Exception {
        return new JSONObject()
                .put("observation_id", observation.getString("observation_id"))
                .put("observation_digest", observation.getString("observation_digest"))
                .put("node_id", observation.getJSONArray("nodes").getJSONObject(index).getString("node_id"));
    }

    private void installWindow(AccessibilityNodeInfo newRoot, int id, String packageName) {
        installWindow(newRoot, id, packageName, true, true);
    }

    private void installWindow(AccessibilityNodeInfo newRoot, int id, String packageName, boolean active, boolean focused) {
        newRoot.setPackageName(packageName);
        AccessibilityWindowInfo window = AccessibilityWindowInfo.obtain();
        ShadowAccessibilityWindowInfo shadowWindow = shadowOf(window);
        shadowWindow.setId(id);
        shadowWindow.setActive(active);
        shadowWindow.setFocused(focused);
        shadowWindow.setRoot(newRoot);
        shadowOf(newRoot).setAccessibilityWindowInfo(window);
        shadowOf(service).setWindows(java.util.List.of(window));
    }

    private static AccessibilityNodeInfo node(
            String className, String text, boolean clickable, boolean editable, boolean scrollable, boolean password
    ) {
        AccessibilityNodeInfo node = AccessibilityNodeInfo.obtain();
        node.setClassName(className);
        node.setText(text);
        node.setClickable(clickable);
        node.setEditable(editable);
        node.setScrollable(scrollable);
        node.setPassword(password);
        node.setEnabled(true);
        node.setBoundsInScreen(new Rect(0, 0, 100, 40));
        return node;
    }
}
