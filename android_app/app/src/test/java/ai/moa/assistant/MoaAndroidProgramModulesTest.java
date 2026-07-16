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
        askEnvelope.getJSONObject("approval_policy").put("always_ask", new JSONArray().put("external_side_effect"));
        MoaSurfaceProgramContract.Proposal ask = MoaSurfaceProgramContract.parse(askEnvelope, "android_fixture", 1_800_000_000_000L);
        assertEquals("approval_required", host.call(ask, MoaScriptExecutionCatalog.CLICK, nodeInput()).code);
        JSONObject localPolicyEnvelope = MoaSurfaceProgramContractTest.valid();
        localPolicyEnvelope.getJSONObject("approval_policy").put("program", "local_policy");
        MoaSurfaceProgramContract.Proposal localPolicy = MoaSurfaceProgramContract.parse(localPolicyEnvelope, "android_fixture", 1_800_000_000_000L);
        assertEquals("approval_required", host.call(localPolicy, MoaScriptExecutionCatalog.CLICK, nodeInput()).code);

        fake.matches = false;
        assertEquals("stale_state", host.call(proposal, MoaScriptExecutionCatalog.OBSERVE, new JSONObject()).status);
        fake.matches = true;
        fake.observation = null;
        assertEquals("accessibility_unavailable", host.call(proposal, MoaScriptExecutionCatalog.OBSERVE, new JSONObject()).code);
        fake.observation = new JSONObject().put("observation_id", "obs_new");
        assertTrue(host.call(proposal, MoaScriptExecutionCatalog.OBSERVE, new JSONObject()).ok);
        fake.found = null;
        assertEquals("stale_state", host.call(proposal, MoaScriptExecutionCatalog.FIND, findInput()).status);
        fake.found = new JSONObject().put("nodes", new JSONArray());
        assertTrue(host.call(proposal, MoaScriptExecutionCatalog.FIND, findInput()).ok);
        fake.action = MoaAccessibilityService.ProgramActionResult.success("clicked", new JSONObject());
        assertTrue(host.call(proposal, MoaScriptExecutionCatalog.CLICK, nodeInput()).ok);
        assertEquals("capability_not_allowed", host.call(proposal, MoaScriptExecutionCatalog.SET_TEXT, nodeInput().put("text", "fixture")).code);
        fake.action = MoaAccessibilityService.ProgramActionResult.rejected("no", "no");
        assertFalse(host.call(proposal, MoaScriptExecutionCatalog.CLICK, nodeInput()).ok);

        assertTrue(MoaAndroidProgramHost.HostResult.success("ok", null).ok);
        assertEquals("stale_state", MoaAndroidProgramHost.HostResult.stale("stale").code);
        assertEquals("denied", MoaAndroidProgramHost.HostResult.rejected("denied", "no").code);
        assertTrue(MoaAndroidProgramHost.HostResult.rejected("approval_required", "no").isAuthorityDenial());
        assertTrue(MoaAndroidProgramHost.HostResult.rejected("policy_denied", "no").isAuthorityDenial());
        assertTrue(MoaAndroidProgramHost.HostResult.rejected("capability_not_allowed", "no").isAuthorityDenial());
        assertFalse(MoaAndroidProgramHost.HostResult.rejected("tool_failed", "no").isAuthorityDenial());
        assertNotNull(new MoaAndroidProgramHost());
        MoaAndroidProgramHost platformHost = new MoaAndroidProgramHost();
        assertEquals("stale_state", platformHost.call(proposal, MoaScriptExecutionCatalog.OBSERVE, new JSONObject()).status);
        Class<?> platformType = Class.forName("ai.moa.assistant.MoaAndroidProgramHost$PlatformAccessibilityAdapter");
        java.lang.reflect.Constructor<?> platformConstructor = platformType.getDeclaredConstructor(); platformConstructor.setAccessible(true);
        MoaAndroidProgramHost.AccessibilityAdapter platform = (MoaAndroidProgramHost.AccessibilityAdapter) platformConstructor.newInstance();
        assertNull(platform.observe(proposal)); assertNull(platform.find(proposal, findInput()));
        assertFalse(platform.act(proposal, MoaScriptExecutionCatalog.BACK, new JSONObject()).success);
    }

    @Test public void hostRejectsEveryClosedInputVariantAndExercisesPlatformShapes() throws Exception {
        FakeAccessibility fake = new FakeAccessibility(); MoaAndroidProgramHost host = new MoaAndroidProgramHost(fake);
        assertEquals("invalid_input", host.call(proposal, MoaScriptExecutionCatalog.OBSERVE, new JSONObject().put("extra", true)).code);
        assertEquals("invalid_input", host.call(proposal, MoaScriptExecutionCatalog.CLICK, new JSONObject()).code);
        assertEquals("invalid_input", host.call(proposal, MoaScriptExecutionCatalog.CLICK, nodeInput().put("extra", true)).code);
        assertEquals("invalid_input", host.call(proposal, MoaScriptExecutionCatalog.CLICK, nodeInput().put("node_id", "")).code);
        assertEquals("invalid_input", host.call(proposal, MoaScriptExecutionCatalog.SCROLL, nodeInput().put("direction", "sideways")).code);
        assertEquals("capability_not_allowed", host.call(proposal, MoaScriptExecutionCatalog.SET_TEXT, nodeInput().put("text", "x".repeat(4097))).code);
        assertEquals("invalid_input", host.call(proposal, MoaScriptExecutionCatalog.FIND, nodeInput()).code);
        fake.action = MoaAccessibilityService.ProgramActionResult.success("done", null, "1".repeat(64));
        assertTrue(host.call(proposal, MoaScriptExecutionCatalog.SCROLL, nodeInput().put("direction", "forward")).ok);
        assertTrue(host.call(proposal, MoaScriptExecutionCatalog.SCROLL, nodeInput().put("direction", "backward")).ok);
        assertTrue(host.call(proposal, MoaScriptExecutionCatalog.BACK, new JSONObject()).ok);
        assertTrue(host.call(proposal, MoaScriptExecutionCatalog.HOME, new JSONObject()).ok);
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

    @Test public void storeDurablySequencesEventsPendingEffectsAndPrestartRejection() throws Exception {
        MoaSurfaceProgramStore store = new MoaSurfaceProgramStore(context);
        assertTrue(store.recordPending(proposal, "client"));
        JSONObject pending = store.existing(proposal.executionId, proposal.idempotencyKey);
        assertEquals(2, pending.getJSONArray("events").length());
        assertTrue(store.beginTool(proposal, "client", "call", MoaScriptExecutionCatalog.CLICK, "1".repeat(64), true, 10));
        assertTrue(store.beginTool(proposal, "client", "other", MoaScriptExecutionCatalog.CLICK, "1".repeat(64), true, 10));
        assertTrue(store.beginTool(proposal, "client", "read", MoaScriptExecutionCatalog.OBSERVE, "1".repeat(64), false, 10));
        pending = store.existing(proposal.executionId, proposal.idempotencyKey); assertTrue(store.hasPendingEffect(pending));
        JSONObject receipt = MoaSurfaceProgramReceipts.toolBound(proposal, "client", "call", 1, MoaScriptExecutionCatalog.CLICK,
                new JSONObject(), "succeeded", "", proposal.observationDigest, "2".repeat(64), 10, 11);
        assertTrue(store.finishTool(proposal, "client", "call", MoaScriptExecutionCatalog.CLICK, receipt, 11));
        pending = store.existing(proposal.executionId, proposal.idempotencyKey); assertTrue(store.hasPendingEffect(pending));
        assertTrue(store.finishTool(proposal, "client", "other", MoaScriptExecutionCatalog.CLICK, receipt, 11));
        JSONObject readReceipt = MoaSurfaceProgramReceipts.toolBound(proposal, "client", "read", 1, MoaScriptExecutionCatalog.OBSERVE,
                new JSONObject(), "succeeded", receipt.getString("receipt_sha256"), proposal.observationDigest, null, 10, 11);
        assertTrue(store.finishTool(proposal, "client", "read", MoaScriptExecutionCatalog.OBSERVE, readReceipt, 11));
        pending = store.existing(proposal.executionId, proposal.idempotencyKey); assertFalse(store.hasPendingEffect(pending)); assertEquals(8, pending.getJSONArray("events").length());
        JSONObject terminal = MoaSurfaceProgramReceipts.terminal(proposal, "client", "completed", new JSONArray().put(receipt), 9, 12, "2".repeat(64), null);
        assertTrue(store.recordTerminal(proposal, "client", terminal)); assertEquals(9, store.existing(proposal.executionId, proposal.idempotencyKey).getJSONArray("events").length());
        assertFalse(store.beginTool(proposal, "client", "later", MoaScriptExecutionCatalog.OBSERVE, "1".repeat(64), false, 13));
        assertFalse(store.finishTool(proposal, "client", "later", MoaScriptExecutionCatalog.OBSERVE, receipt, 13));

        context.getSharedPreferences("moa_surface_programs_v1", Context.MODE_PRIVATE).edit().clear().commit();
        JSONObject rejected = store.recordRejected(proposal, "client", "stale_state"); assertNotNull(rejected); assertNull(store.recordRejected(proposal, "client", "stale_state"));
        assertFalse(store.hasPendingEffect(null));

        context.getSharedPreferences("moa_surface_programs_v1", Context.MODE_PRIVATE).edit().clear().commit(); assertTrue(store.recordPending(proposal, "client"));
        assertTrue(store.beginTool(proposal, "client", "crashed", MoaScriptExecutionCatalog.CLICK, "4".repeat(64), true, 10));
        assertNotNull(store.recoverIndeterminate(proposal, "client")); JSONObject recovered = store.existing(proposal.executionId, proposal.idempotencyKey);
        assertEquals("indeterminate", recovered.getJSONObject("terminal").getString("status")); assertEquals(1, recovered.getJSONArray("tool_receipts").length());
        assertNull(store.recoverIndeterminate(proposal, "client"));
    }

    @Test public void webViewRuntimeStopsTimesOutAndReturnsBoundReceiptsWithoutLaunchingUi() throws Exception {
        MoaSurfaceProgramStore store = new MoaSurfaceProgramStore(context);
        assertTrue(store.recordPending(proposal));
        List<JSONObject> results = new ArrayList<>();
        FakeEngine engine = new FakeEngine();
        FakeAccessibility accessibility = new FakeAccessibility();
        MoaWebViewProgramRuntime runtime = new MoaWebViewProgramRuntime(new MoaAndroidProgramHost(accessibility), store, engine);
        runtime.stop("idle");
        runtime.execute(proposal, "client", (receipt, tools) -> results.add(receipt));
        runtime.stop("fixture_stop");
        assertEquals("stopped", results.get(0).optString("status"));
        assertTrue(engine.stops > 0);
        runtime.stop("already_stopped");

        results.clear();
        context.getSharedPreferences("moa_surface_programs_v1", Context.MODE_PRIVATE).edit().clear().commit();
        assertTrue(store.recordPending(proposal));
        runtime.execute(proposal, "client", (receipt, tools) -> results.add(receipt));
        ShadowLooper.idleMainLooper(proposal.limits.wallMs + 1L, TimeUnit.MILLISECONDS);
        assertEquals("timed_out", results.get(0).optString("status"));
        Field executionField = MoaWebViewProgramRuntime.class.getDeclaredField("execution"); executionField.setAccessible(true);
        Method timeout = MoaWebViewProgramRuntime.class.getDeclaredMethod("timeout", Class.forName("ai.moa.assistant.MoaWebViewProgramRuntime$Execution")); timeout.setAccessible(true);
        timeout.invoke(runtime, new Object[]{null});

        results.clear(); context.getSharedPreferences("moa_surface_programs_v1", Context.MODE_PRIVATE).edit().clear().commit(); assertTrue(store.recordPending(proposal));
        runtime.execute(proposal, "client", (receipt, tools) -> results.add(receipt)); Object detached = executionField.get(runtime); executionField.set(runtime, null);
        timeout.invoke(runtime, detached); assertTrue(results.isEmpty());

        context.getSharedPreferences("moa_surface_programs_v1", Context.MODE_PRIVATE).edit().clear().commit(); assertTrue(store.recordPending(proposal));
        runtime.execute(proposal, "client", (receipt, tools) -> results.add(receipt)); Object alreadyTerminal = executionField.get(runtime);
        Field terminalField = alreadyTerminal.getClass().getDeclaredField("terminal"); terminalField.setAccessible(true); terminalField.setBoolean(alreadyTerminal, true);
        Method finishMethod = alreadyTerminal.getClass().getDeclaredMethod("finish", String.class, String.class, Object.class); finishMethod.setAccessible(true);
        finishMethod.invoke(alreadyTerminal, "failed", "runtime_failed", null);
        runtime.stop("idle"); assertTrue(results.isEmpty());

        results.clear();
        context.getSharedPreferences("moa_surface_programs_v1", Context.MODE_PRIVATE).edit().clear().commit();
        assertTrue(store.recordPending(proposal));
        Thread background = new Thread(() -> runtime.execute(proposal, "client", (receipt, tools) -> results.add(receipt)));
        background.start(); background.join();
        ShadowLooper.runUiThreadTasks();
        engine.finish("{\"type\":\"terminal\",\"ok\":true,\"result\":{\"fixture\":true}}");
        ShadowLooper.runUiThreadTasks();
        assertEquals("completed", results.get(0).optString("status"));
        engine.finish("{\"type\":\"terminal\",\"ok\":true,\"result\":null}"); ShadowLooper.runUiThreadTasks();

        results.clear();
        context.getSharedPreferences("moa_surface_programs_v1", Context.MODE_PRIVATE).edit().clear().commit();
        assertTrue(store.recordPending(proposal));
        runtime.execute(proposal, "client", (receipt, tools) -> results.add(receipt));
        engine.call(new JSONObject().put("call_id", "call_1").put("capability_id", MoaScriptExecutionCatalog.OBSERVE).put("input", new JSONObject()).toString());
        ShadowLooper.runUiThreadTasks();
        assertEquals(1, engine.responses.size());
        engine.finish("{\"type\":\"terminal\",\"ok\":true,\"result\":null}");
        ShadowLooper.runUiThreadTasks();
        assertEquals("completed", results.get(0).optString("status"));

        results.clear();
        context.getSharedPreferences("moa_surface_programs_v1", Context.MODE_PRIVATE).edit().clear().commit();
        assertTrue(store.recordPending(proposal));
        runtime.execute(proposal, "client", (receipt, tools) -> results.add(receipt));
        engine.call("not-json"); ShadowLooper.runUiThreadTasks();
        assertEquals("failed", results.get(0).optString("status"));
    }

    @Test public void runtimeFailsClosedAcrossWorkerToolBudgetMutationAndResultBranches() throws Exception {
        MoaSurfaceProgramStore store = new MoaSurfaceProgramStore(context); FakeEngine engine = new FakeEngine(); FakeAccessibility ax = new FakeAccessibility();
        MoaWebViewProgramRuntime runtime = new MoaWebViewProgramRuntime(new MoaAndroidProgramHost(ax), store, engine); List<JSONObject> terminal = new ArrayList<>();

        resetPending(store); runtime.execute(proposal, "client", (receipt, tools) -> terminal.add(receipt));
        engine.call(new JSONObject().put("call_id", "").put("capability_id", MoaScriptExecutionCatalog.OBSERVE).put("input", new JSONObject()).toString()); ShadowLooper.runUiThreadTasks();
        assertEquals("runtime_failed", terminal.get(0).getJSONObject("error").getString("code"));

        terminal.clear(); resetPending(store); runtime.execute(proposal, "client", (receipt, tools) -> terminal.add(receipt));
        String observe = new JSONObject().put("call_id", "same").put("capability_id", MoaScriptExecutionCatalog.OBSERVE).put("input", new JSONObject()).toString();
        engine.call(observe); engine.call(observe); ShadowLooper.runUiThreadTasks(); assertEquals("runtime_failed", terminal.get(0).getJSONObject("error").getString("code"));

        terminal.clear(); resetPending(store); runtime.execute(proposal, "client", (receipt, tools) -> terminal.add(receipt));
        ax.action = MoaAccessibilityService.ProgramActionResult.success("done", null, "2".repeat(64));
        engine.call(new JSONObject().put("call_id", "mutation").put("capability_id", MoaScriptExecutionCatalog.CLICK).put("input", nodeInput()).toString()); ShadowLooper.runUiThreadTasks();
        assertTrue(engine.responses.get(engine.responses.size() - 1).getBoolean("ok")); engine.finish("{\"type\":\"terminal\",\"ok\":true,\"result\":null}"); ShadowLooper.runUiThreadTasks();
        assertEquals("2".repeat(64), terminal.get(0).getString("final_state_sha256"));

        terminal.clear(); resetPending(store); runtime.execute(proposal, "client", (receipt, tools) -> terminal.add(receipt));
        engine.finish("{\"type\":\"terminal\",\"ok\":false,\"code\":\"secret_SENTINEL\"}"); ShadowLooper.runUiThreadTasks();
        assertEquals("runtime_failed", terminal.get(0).getJSONObject("error").getString("code")); assertFalse(terminal.get(0).toString().contains("SENTINEL"));

        terminal.clear(); resetPending(store); runtime.execute(proposal, "client", (receipt, tools) -> terminal.add(receipt));
        engine.finish("not-json"); ShadowLooper.runUiThreadTasks(); assertEquals("failed", terminal.get(0).getString("status"));

        terminal.clear(); resetPending(store); runtime.execute(proposal, "client", (receipt, tools) -> terminal.add(receipt));
        engine.finish(new JSONObject().put("type", "terminal").put("ok", true).put("result", "x".repeat(5000)).toString()); ShadowLooper.runUiThreadTasks();
        assertEquals("limit_exceeded", terminal.get(0).getJSONObject("error").getString("code"));

        terminal.clear(); context.getSharedPreferences("moa_surface_programs_v1", Context.MODE_PRIVATE).edit().clear().commit();
        runtime.execute(proposal, "client", (receipt, tools) -> terminal.add(receipt));
        engine.call(new JSONObject().put("call_id", "nostore").put("capability_id", MoaScriptExecutionCatalog.OBSERVE).put("input", new JSONObject()).toString()); ShadowLooper.runUiThreadTasks(); assertTrue(terminal.isEmpty());

        terminal.clear(); resetPending(store); runtime.execute(proposal, "client", (receipt, tools) -> terminal.add(receipt));
        ax.action = MoaAccessibilityService.ProgramActionResult.success("missing post", null);
        engine.call(new JSONObject().put("call_id", "missingpost").put("capability_id", MoaScriptExecutionCatalog.CLICK).put("input", nodeInput()).toString()); ShadowLooper.runUiThreadTasks();
        assertTrue(terminal.isEmpty());
        assertEquals("indeterminate", store.recoverIndeterminate(proposal, "client").getString("status"));

        terminal.clear(); resetPending(store); runtime.execute(proposal, "client", (receipt, tools) -> terminal.add(receipt));
        ax.action = MoaAccessibilityService.ProgramActionResult.success("done", null, "3".repeat(64));
        ax.onAct = () -> context.getSharedPreferences("moa_surface_programs_v1", Context.MODE_PRIVATE).edit().clear().commit();
        engine.call(new JSONObject().put("call_id", "lostfinish").put("capability_id", MoaScriptExecutionCatalog.CLICK).put("input", nodeInput()).toString()); ShadowLooper.runUiThreadTasks(); assertTrue(terminal.isEmpty()); ax.onAct = null;

        terminal.clear(); resetPending(store); runtime.execute(proposal, "client", (receipt, tools) -> terminal.add(receipt)); runtime.stop("surface_shutdown"); assertEquals("surface_shutdown", terminal.get(0).getJSONObject("error").getString("code"));
        terminal.clear(); resetPending(store); runtime.execute(proposal, "client", (receipt, tools) -> terminal.add(receipt)); runtime.stop("overlay_stopped"); assertEquals("surface_shutdown", terminal.get(0).getJSONObject("error").getString("code"));

        terminal.clear(); resetPending(store); runtime.execute(proposal, "client", (receipt, tools) -> terminal.add(receipt));
        engine.call(new JSONObject().put("call_id", "stale").put("capability_id", MoaScriptExecutionCatalog.OBSERVE).toString()); ax.matches = false; ShadowLooper.runUiThreadTasks();
        assertEquals("Bound state is stale.", engine.responses.get(engine.responses.size() - 1).getString("error")); ax.matches = true; runtime.stop("user_stop");

        terminal.clear(); resetPending(store); ax.observation = null; runtime.execute(proposal, "client", (receipt, tools) -> terminal.add(receipt));
        engine.call(new JSONObject().put("call_id", "unavailable").put("capability_id", MoaScriptExecutionCatalog.OBSERVE).put("input", new JSONObject()).toString()); ShadowLooper.runUiThreadTasks();
        assertEquals("Local capability ended without success.", engine.responses.get(engine.responses.size() - 1).getString("error")); runtime.stop("user_stop"); ax.observation = new JSONObject();

        terminal.clear(); int responsesBeforeDenial = engine.responses.size();
        JSONObject askEnvelope = MoaSurfaceProgramContractTest.valid();
        askEnvelope.getJSONObject("approval_policy").put("always_ask", new JSONArray().put("external_side_effect"));
        MoaSurfaceProgramContract.Proposal ask = MoaSurfaceProgramContract.parse(askEnvelope, "android_fixture", 1_800_000_000_000L);
        context.getSharedPreferences("moa_surface_programs_v1", Context.MODE_PRIVATE).edit().clear().commit(); assertTrue(store.recordPending(ask));
        runtime.execute(ask, "client", (receipt, tools) -> terminal.add(receipt));
        engine.call(new JSONObject().put("call_id", "denied").put("capability_id", MoaScriptExecutionCatalog.CLICK).put("input", nodeInput()).toString()); ShadowLooper.runUiThreadTasks();
        assertEquals("rejected", terminal.get(0).getString("status"));
        assertEquals("policy_denied", terminal.get(0).getJSONObject("error").getString("code"));
        assertEquals(responsesBeforeDenial, engine.responses.size());

        terminal.clear(); resetPending(store); runtime.execute(proposal, "client", (receipt, tools) -> terminal.add(receipt));
        engine.finish("{\"type\":\"terminal\",\"ok\":false,\"code\":\"policy_denied\"}"); ShadowLooper.runUiThreadTasks();
        assertEquals("rejected", terminal.get(0).getString("status"));
        assertEquals("policy_denied", terminal.get(0).getJSONObject("error").getString("code"));

        terminal.clear(); resetPending(store); runtime.execute(proposal, "client", (receipt, tools) -> terminal.add(receipt));
        for (int i = 0; i <= proposal.limits.toolCalls; i++) engine.call(new JSONObject().put("call_id", "many_" + i).put("capability_id", MoaScriptExecutionCatalog.OBSERVE).put("input", new JSONObject()).toString());
        ShadowLooper.runUiThreadTasks(); assertEquals("limit_exceeded", terminal.get(0).getJSONObject("error").getString("code"));

        terminal.clear(); resetPending(store); runtime.execute(proposal, "client", (receipt, tools) -> terminal.add(receipt));
        ax.onObserve = () -> context.getSharedPreferences("moa_surface_programs_v1", Context.MODE_PRIVATE).edit().clear().commit();
        engine.call(new JSONObject().put("call_id", "lostread").put("capability_id", MoaScriptExecutionCatalog.OBSERVE).put("input", new JSONObject()).toString()); ShadowLooper.runUiThreadTasks(); assertTrue(terminal.isEmpty()); ax.onObserve = null;

        terminal.clear(); resetPending(store); runtime.execute(proposal, "client", (receipt, tools) -> terminal.add(receipt)); context.getSharedPreferences("moa_surface_programs_v1", Context.MODE_PRIVATE).edit().clear().commit();
        engine.finish("{\"type\":\"terminal\",\"ok\":true,\"result\":null}"); ShadowLooper.runUiThreadTasks(); assertTrue(terminal.isEmpty());
    }

    @Test public void infiniteGeneratedLoopCannotBlockMainWatchdogAndNextRun() throws Exception {
        MoaSurfaceProgramStore store = new MoaSurfaceProgramStore(context); resetPending(store); BlockingEngine engine = new BlockingEngine(); List<JSONObject> results = new ArrayList<>();
        MoaWebViewProgramRuntime runtime = new MoaWebViewProgramRuntime(new MoaAndroidProgramHost(new FakeAccessibility()), store, engine);
        runtime.execute(proposal, "client", (receipt, tools) -> results.add(receipt));
        ShadowLooper.idleMainLooper(proposal.limits.wallMs + 1L, TimeUnit.MILLISECONDS);
        assertEquals("timed_out", results.get(0).optString("status")); assertTrue(engine.stopped);
        context.getSharedPreferences("moa_surface_programs_v1", Context.MODE_PRIVATE).edit().clear().commit(); assertTrue(store.recordPending(proposal)); results.clear();
        runtime.execute(proposal, "client", (receipt, tools) -> results.add(receipt)); engine.listener.finish("{\"type\":\"terminal\",\"ok\":true,\"result\":null}"); ShadowLooper.runUiThreadTasks();
        assertEquals("completed", results.get(0).optString("status"));
    }

    private void resetPending(MoaSurfaceProgramStore store) { context.getSharedPreferences("moa_surface_programs_v1", Context.MODE_PRIVATE).edit().clear().commit(); assertTrue(store.recordPending(proposal)); }

    private static final class FakeAccessibility implements MoaAndroidProgramHost.AccessibilityAdapter {
        boolean matches = true;
        JSONObject observation = new JSONObject();
        JSONObject found = new JSONObject();
        MoaAccessibilityService.ProgramActionResult action = MoaAccessibilityService.ProgramActionResult.failed("failed"); Runnable onAct, onObserve;
        public boolean bindingMatches(MoaSurfaceProgramContract.Proposal ignored) { return matches; }
        public JSONObject observe(MoaSurfaceProgramContract.Proposal ignored) { if (onObserve != null) onObserve.run(); return observation; }
        public JSONObject find(MoaSurfaceProgramContract.Proposal proposal, JSONObject ignored) { return found; }
        public MoaAccessibilityService.ProgramActionResult act(MoaSurfaceProgramContract.Proposal ignored, String capabilityId, JSONObject input) { if (onAct != null) onAct.run(); return action; }
    }

    private static final class FakeEngine implements MoaWebViewProgramRuntime.Engine {
        MoaWebViewProgramRuntime.EngineListener listener; int stops; final List<JSONObject> responses = new ArrayList<>();
        public void start(String source, JSONArray allowed, MoaWebViewProgramRuntime.EngineListener listener) { this.listener = listener; }
        public void respond(JSONObject payload) { responses.add(payload); }
        public void stop() { stops++; }
        void call(String payload) { listener.call(payload); }
        void finish(String payload) { listener.finish(payload); }
    }
    private static final class BlockingEngine implements MoaWebViewProgramRuntime.Engine {
        volatile boolean stopped; MoaWebViewProgramRuntime.EngineListener listener; Thread loop;
        public void start(String source, JSONArray allowed, MoaWebViewProgramRuntime.EngineListener listener) { this.listener = listener; stopped = false; loop = new Thread(() -> { while (!stopped) Thread.onSpinWait(); }); loop.start(); }
        public void respond(JSONObject payload) {}
        public void stop() { stopped = true; if (loop != null) try { loop.join(1000); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); } }
    }

    private static JSONObject nodeInput() throws Exception { return new JSONObject().put("observation_id", "obs_1").put("observation_digest", "b".repeat(64)).put("node_id", "node_1"); }
    private static JSONObject findInput() throws Exception { return new JSONObject().put("observation_id", "obs_1").put("observation_digest", "b".repeat(64)).put("query", "fixture"); }
}
