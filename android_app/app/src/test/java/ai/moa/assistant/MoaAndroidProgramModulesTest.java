package ai.moa.assistant;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowLooper;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.lang.reflect.Field;
import java.lang.reflect.Method;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public final class MoaAndroidProgramModulesTest {
    private Context context;
    private MoaSurfaceProgramContract.Proposal proposal;

    @Before public void setUp() throws Exception {
        context = RuntimeEnvironment.getApplication();
        context.getSharedPreferences("moa_surface_programs_v1", Context.MODE_PRIVATE).edit().clear().commit();
        proposal = MoaSurfaceProgramContract.parse(MoaSurfaceProgramContractTest.valid(), "android_fixture", 1_800_000_000_000L);
    }

    @Test public void hostEnforcesCatalogApprovalTargetAndAdapterResults() throws Exception {
        FakeAccessibility fake = new FakeAccessibility();
        MoaAndroidProgramHost host = new MoaAndroidProgramHost(fake);
        assertEquals("capability_not_allowed", host.call(proposal, "android.shell.execute", new JSONObject()).code);
        assertEquals("capability_not_allowed", host.call(proposal, "android.accessibility.unknown", new JSONObject()).code);

        JSONObject askEnvelope = MoaSurfaceProgramContractTest.valid();
        askEnvelope.getJSONObject("approval_policy").put("always_ask", new JSONArray().put("navigation"));
        MoaSurfaceProgramContract.Proposal ask = MoaSurfaceProgramContract.parse(askEnvelope, "android_fixture", 1_800_000_000_000L);
        assertEquals("approval_required", host.call(ask, MoaScriptExecutionCatalog.CLICK, new JSONObject()).code);
        JSONObject localPolicyEnvelope = MoaSurfaceProgramContractTest.valid();
        localPolicyEnvelope.getJSONObject("approval_policy").put("program", "local_policy");
        MoaSurfaceProgramContract.Proposal localPolicy = MoaSurfaceProgramContract.parse(localPolicyEnvelope, "android_fixture", 1_800_000_000_000L);
        assertEquals("approval_required", host.call(localPolicy, MoaScriptExecutionCatalog.SET_TEXT, new JSONObject()).code);

        fake.matches = false;
        assertEquals("stale_state", host.call(proposal, MoaScriptExecutionCatalog.OBSERVE, new JSONObject()).status);
        fake.matches = true;
        fake.observation = null;
        assertEquals("accessibility_unavailable", host.call(proposal, MoaScriptExecutionCatalog.OBSERVE, new JSONObject()).code);
        fake.observation = new JSONObject().put("observation_id", "obs_new");
        assertTrue(host.call(proposal, MoaScriptExecutionCatalog.OBSERVE, new JSONObject()).ok);
        fake.found = null;
        assertEquals("stale_state", host.call(proposal, MoaScriptExecutionCatalog.FIND, new JSONObject()).status);
        fake.found = new JSONObject().put("nodes", new JSONArray());
        assertTrue(host.call(proposal, MoaScriptExecutionCatalog.FIND, new JSONObject()).ok);
        fake.action = MoaAccessibilityService.ProgramActionResult.success("clicked", new JSONObject());
        assertTrue(host.call(proposal, MoaScriptExecutionCatalog.CLICK, new JSONObject()).ok);
        assertTrue(host.call(proposal, MoaScriptExecutionCatalog.SET_TEXT, new JSONObject()).ok);
        fake.action = MoaAccessibilityService.ProgramActionResult.rejected("no", "no");
        assertFalse(host.call(proposal, MoaScriptExecutionCatalog.CLICK, new JSONObject()).ok);

        assertTrue(MoaAndroidProgramHost.HostResult.success("ok", null).ok);
        assertEquals("stale_state", MoaAndroidProgramHost.HostResult.stale("stale").code);
        assertEquals("denied", MoaAndroidProgramHost.HostResult.rejected("denied", "no").code);
        assertNotNull(new MoaAndroidProgramHost());
    }

    @Test public void storeCommitsPendingToolAndTerminalReceiptsAndRejectsReplay() throws Exception {
        MoaSurfaceProgramStore store = new MoaSurfaceProgramStore(context);
        assertNull(store.existing(proposal.executionId, proposal.idempotencyKey));
        assertTrue(store.recordPending(proposal));
        assertFalse(store.recordPending(proposal));
        assertNotNull(store.existing(proposal.executionId, "different"));
        assertNotNull(store.existing("different", proposal.idempotencyKey));

        JSONObject tool = MoaSurfaceProgramReceipts.tool(proposal, "client", "call_1", 1, MoaScriptExecutionCatalog.OBSERVE,
                new JSONObject(), "succeeded", "ok", "", "", 10, 11);
        assertTrue(store.recordToolReceipt(proposal, tool));
        JSONObject pending = store.existing(proposal.executionId, proposal.idempotencyKey);
        assertEquals(1, pending.getJSONArray("tool_receipts").length());
        JSONObject terminal = MoaSurfaceProgramReceipts.terminal(proposal, "client", "completed", "done", "", "", "", new JSONArray().put(tool), 10, 12);
        assertTrue(store.recordTerminal(proposal, terminal));
        assertEquals("completed", store.existing(proposal.executionId, proposal.idempotencyKey).getString("status"));
        assertFalse(store.recordToolReceipt(proposal, tool));

        JSONObject otherEnvelope = MoaSurfaceProgramContractTest.valid().put("execution_id", "exec_other").put("idempotency_key", "idem_other");
        MoaSurfaceProgramContract.Proposal other = MoaSurfaceProgramContract.parse(otherEnvelope, "android_fixture", 1_800_000_000_000L);
        assertFalse(store.recordTerminal(other, terminal));

        JSONArray noise = new JSONArray().put("not-an-object")
                .put(new JSONObject().put("execution_id", "unmatched").put("idempotency_key", "unmatched").put("status", "done"))
                .put(new JSONObject().put("execution_id", proposal.executionId).put("idempotency_key", proposal.idempotencyKey).put("status", "pending"));
        context.getSharedPreferences("moa_surface_programs_v1", Context.MODE_PRIVATE).edit().putString("entries", noise.toString()).commit();
        assertNull(store.existing("none", "none"));
        assertTrue(store.recordToolReceipt(proposal, tool));

        JSONArray missingReceiptList = new JSONArray().put(new JSONObject().put("execution_id", proposal.executionId)
                .put("idempotency_key", proposal.idempotencyKey).put("status", "pending"));
        context.getSharedPreferences("moa_surface_programs_v1", Context.MODE_PRIVATE).edit().putString("entries", missingReceiptList.toString()).commit();
        assertTrue(store.recordToolReceipt(proposal, tool));

        JSONArray many = new JSONArray();
        for (int i = 0; i < 81; i++) many.put(new JSONObject().put("execution_id", "old_" + i).put("idempotency_key", "old_idem_" + i));
        context.getSharedPreferences("moa_surface_programs_v1", Context.MODE_PRIVATE).edit().putString("entries", many.toString()).commit();
        assertTrue(store.recordPending(proposal));
        assertEquals(80, new JSONArray(context.getSharedPreferences("moa_surface_programs_v1", Context.MODE_PRIVATE).getString("entries", "[]")).length());
        context.getSharedPreferences("moa_surface_programs_v1", Context.MODE_PRIVATE).edit().putString("entries", "{").commit();
        assertNull(store.existing("none", "none"));
    }

    @Test public void webViewRuntimeStopsTimesOutAndReturnsBoundReceiptsWithoutLaunchingUi() throws Exception {
        MoaSurfaceProgramStore store = new MoaSurfaceProgramStore(context);
        assertTrue(store.recordPending(proposal));
        List<JSONObject> results = new ArrayList<>();
        MoaWebViewProgramRuntime runtime = new MoaWebViewProgramRuntime(context, new MoaAndroidProgramHost(new FakeAccessibility()), store);
        runtime.stop("idle");
        runtime.execute(proposal, "client", (receipt, tools) -> results.add(receipt));
        runtime.stop("fixture_stop");
        assertEquals("stopped", results.get(0).optString("status"));
        runtime.stop("already_stopped");

        results.clear();
        runtime.execute(proposal, "client", (receipt, tools) -> results.add(receipt));
        ShadowLooper.idleMainLooper(proposal.limits.wallMs + 1L, TimeUnit.MILLISECONDS);
        assertEquals("timed_out", results.get(0).optString("status"));

        Method timeout = MoaWebViewProgramRuntime.class.getDeclaredMethod("timeout", Class.forName("ai.moa.assistant.MoaWebViewProgramRuntime$Execution"));
        timeout.setAccessible(true);
        timeout.invoke(runtime, new Object[]{null});

        Method object = MoaWebViewProgramRuntime.class.getDeclaredMethod("object", Object[].class);
        object.setAccessible(true);
        assertEquals(0, ((JSONObject) object.invoke(null, new Object[]{new Object[]{}})).length());
        assertEquals(1, ((JSONObject) object.invoke(null, new Object[]{new Object[]{"key", "value"}})).length());
        try { object.invoke(null, new Object[]{new Object[]{"key", Double.NaN}}); } catch (java.lang.reflect.InvocationTargetException expected) { assertTrue(expected.getCause() instanceof IllegalStateException); }

        Method asset = MoaWebViewProgramRuntime.class.getDeclaredMethod("asset", String.class);
        asset.setAccessible(true);
        assertTrue(((String) asset.invoke(runtime, "moa_program_runtime.html")).contains("new Worker"));
        try { asset.invoke(runtime, "missing.html"); } catch (java.lang.reflect.InvocationTargetException expected) { assertTrue(expected.getCause() instanceof IllegalStateException); }

        results.clear();
        Thread background = new Thread(() -> runtime.execute(proposal, "client", (receipt, tools) -> results.add(receipt)));
        background.start(); background.join();
        ShadowLooper.runUiThreadTasks();
        runtime.stop("background_stop");
        assertEquals("stopped", results.get(0).optString("status"));

        results.clear();
        runtime.execute(proposal, "client", (receipt, tools) -> results.add(receipt));
        Field executionField = MoaWebViewProgramRuntime.class.getDeclaredField("execution");
        executionField.setAccessible(true);
        Object terminalExecution = executionField.get(runtime);
        runtime.stop("first_stop");
        executionField.set(runtime, terminalExecution);
        runtime.stop("terminal_already_recorded");
    }

    private static final class FakeAccessibility implements MoaAndroidProgramHost.AccessibilityAdapter {
        boolean matches = true;
        JSONObject observation = new JSONObject();
        JSONObject found = new JSONObject();
        MoaAccessibilityService.ProgramActionResult action = MoaAccessibilityService.ProgramActionResult.failed("failed");
        public boolean targetMatches(MoaSurfaceProgramContract.Proposal ignored) { return matches; }
        public JSONObject observe() { return observation; }
        public JSONObject find(JSONObject ignored) { return found; }
        public MoaAccessibilityService.ProgramActionResult act(MoaSurfaceProgramContract.Proposal ignored, String capabilityId, JSONObject input) { return action; }
    }
}
