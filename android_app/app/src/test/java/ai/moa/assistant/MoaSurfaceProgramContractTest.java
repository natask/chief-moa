package ai.moa.assistant;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Arrays;
import java.util.LinkedHashSet;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

public final class MoaSurfaceProgramContractTest {
    private static final long NOW = 1_800_000_000_000L;

    @Test public void acceptsExactNormativeAndroidEnvelope() throws Exception {
        JSONObject envelope = valid();
        MoaSurfaceProgramContract.Proposal proposal = MoaSurfaceProgramContract.parse(envelope, "android_fixture", NOW);
        assertEquals("exec_fixture", proposal.executionId);
        assertEquals("session_fixture", proposal.sessionId);
        assertEquals("turn_fixture", proposal.turnId);
        assertEquals("android_fixture", proposal.deviceId);
        assertEquals("com.example.fixture", proposal.expectedPackage);
        assertEquals("7", proposal.windowId);
        assertEquals("obs_fixture", proposal.observationId);
        assertEquals(6, proposal.allowedCapabilityIds.size());
        assertEquals(1024, proposal.limits.parallelCalls * 1024);
        assertFalse(proposal.alwaysAsk.contains(MoaScriptExecutionCatalog.CLICK));
        assertEquals(MoaProgramJson.sha256(MoaProgramJson.canonical(envelope.getJSONObject("bindings"))), proposal.bindingsSha256);
    }

    @Test public void rejectsUnknownAndMissingFieldsAtEveryClosedLayer() throws Exception {
        for (String path : Arrays.asList("", "target", "runtime", "program", "catalog", "bindings", "limits", "approval_policy")) {
            JSONObject value = valid();
            JSONObject target = path.isEmpty() ? value : value.getJSONObject(path);
            target.put("unknown", true);
            rejected(value);
            value = valid();
            target = path.isEmpty() ? value : value.getJSONObject(path);
            String first = target.keys().next();
            target.remove(first);
            rejected(value);
        }
    }

    @Test public void rejectsIdentityTargetRuntimeAndProfileDrift() throws Exception {
        rejectChanged("version", 2);
        rejectChanged("type", "action.proposed");
        for (String key : Arrays.asList("execution_id", "session_id", "turn_id", "idempotency_key")) rejectChanged(key, "has space");
        rejectNested("target", "surface_type", "browser");
        rejectNested("target", "device_id", "another_device");
        rejectNested("runtime", "runtime_id", "gateway.quickjs.v1");
        rejectNested("runtime", "language", "java");
        rejectNested("runtime", "bridge_version", 2);
        rejectNested("runtime", "entrypoint", "async_body");
        rejectNested("bindings", "kind", "gateway_server");
        rejectNested("bindings", "package_name", "bad package");
        rejectNested("bindings", "window_id", "bad window");
        rejectNested("bindings", "observation_id", "bad observation");
        rejectNested("bindings", "state_sha256", "sha256:not-bare");
        for (String key : Arrays.asList("target", "runtime", "program", "catalog", "bindings", "limits", "approval_policy")) {
            JSONObject badObject = valid(); badObject.put(key, "not-an-object"); rejected(badObject);
        }
    }

    @Test public void rejectionCodesProveBothValidationOutcomesExecute() throws Exception {
        assertEquals("unsupported_envelope", rejection(changed(valid(), "type", "wrong")));
        JSONObject wrongSurface = valid(); wrongSurface.getJSONObject("target").put("surface_type", "browser");
        assertEquals("wrong_surface", rejection(wrongSurface));
        JSONObject wrongRuntime = valid(); wrongRuntime.getJSONObject("runtime").put("language", "java");
        assertEquals("runtime_mismatch", rejection(wrongRuntime));
        JSONObject wrongHash = valid(); wrongHash.getJSONObject("program").put("sha256", zeros());
        assertEquals("program_hash_mismatch", rejection(wrongHash));
        JSONObject stale = valid(); stale.put("expires_at", MoaSurfaceProgramEvents.timestamp(NOW));
        assertEquals("expired", rejection(stale));
        assertEquals("exec_fixture", MoaSurfaceProgramContract.parse(valid(), "android_fixture", NOW).executionId);
    }

    @Test public void rejectsProgramAndCatalogDriftOrEscalation() throws Exception {
        rejectNested("program", "source", "async function main() { return 2; }");
        rejectNested("program", "sha256", zeros());
        rejectNested("program", "source", "   ");
        JSONObject nullSource = valid(); nullSource.getJSONObject("program").put("source", JSONObject.NULL); rejected(nullSource);
        String huge = "x".repeat(MoaSurfaceProgramContract.MAX_SOURCE_BYTES + 1);
        JSONObject hugeEnvelope = valid();
        hugeEnvelope.getJSONObject("program").put("source", huge).put("sha256", MoaProgramJson.sha256(huge));
        hugeEnvelope.getJSONObject("limits").put("source_bytes", MoaSurfaceProgramContract.MAX_SOURCE_BYTES);
        rejected(hugeEnvelope);
        rejectNested("catalog", "version", 2);
        rejectNested("catalog", "sha256", zeros());
        JSONObject empty = valid(); empty.getJSONObject("catalog").put("allowed_capability_ids", new JSONArray());
        assertTrue(MoaSurfaceProgramContract.parse(empty, "android_fixture", NOW).allowedCapabilityIds.isEmpty());
        JSONObject duplicate = valid(); duplicate.getJSONObject("catalog").getJSONArray("allowed_capability_ids").put(MoaScriptExecutionCatalog.OBSERVE); rejected(duplicate);
        JSONObject unsorted = valid(); unsorted.getJSONObject("catalog").put("allowed_capability_ids", new JSONArray().put(MoaScriptExecutionCatalog.OBSERVE).put(MoaScriptExecutionCatalog.BACK)); rejected(unsorted);
        JSONObject nonString = valid(); nonString.getJSONObject("catalog").put("allowed_capability_ids", new JSONArray().put(7)); rejected(nonString);
        JSONObject escalated = valid(); escalated.getJSONObject("catalog").put("allowed_capability_ids", new JSONArray().put("android.shell.execute")); rejected(escalated);
        JSONObject badId = valid(); badId.getJSONObject("catalog").put("allowed_capability_ids", new JSONArray().put("bad capability")); rejected(badId);
    }

    @Test public void rejectsEveryResourceLimitViolation() throws Exception {
        rejectLimit("source_bytes", 0); rejectLimit("source_bytes", 65537); rejectLimit("source_bytes", 1);
        rejectLimit("wall_ms", 99); rejectLimit("wall_ms", 30001);
        rejectLimit("memory_bytes", 1);
        rejectLimit("tool_calls", 0); rejectLimit("tool_calls", 101);
        rejectLimit("parallel_calls", 0); rejectLimit("parallel_calls", 2);
        rejectLimit("result_bytes", 0); rejectLimit("result_bytes", 65537);
        rejectLimit("log_bytes", -1); rejectLimit("log_bytes", 32769);
        rejectLimit("wall_ms", 3.5); rejectLimit("wall_ms", "1000");
    }

    @Test public void rejectsApprovalAndTimeViolations() throws Exception {
        rejectNested("approval_policy", "program", "");
        rejectNested("approval_policy", "program", "x".repeat(81));
        rejectNested("approval_policy", "program", "gateway_override");
        rejectNested("approval_policy", "always_ask", true);
        JSONObject askEscalation = valid(); askEscalation.getJSONObject("approval_policy").put("always_ask", new JSONArray().put("android.shell.execute")); rejected(askEscalation);
        JSONObject askUnsorted = valid(); askUnsorted.getJSONObject("approval_policy").put("always_ask", new JSONArray().put("sending").put("read")); rejected(askUnsorted);
        for (String policy : Arrays.asList("local_policy", "approval_required")) {
            JSONObject allowedPolicy = valid(); allowedPolicy.getJSONObject("approval_policy").put("program", policy);
            assertEquals(policy, MoaSurfaceProgramContract.parse(allowedPolicy, "android_fixture", NOW).programApproval);
        }
        JSONObject allEffects = valid(); allEffects.getJSONObject("approval_policy").put("always_ask", new JSONArray(new java.util.TreeSet<>(MoaScriptExecutionCatalog.EFFECT_CLASSES)));
        assertEquals(MoaScriptExecutionCatalog.EFFECT_CLASSES, MoaSurfaceProgramContract.parse(allEffects, "android_fixture", NOW).alwaysAsk);
        rejectChanged("issued_at", "not-time");
        rejectChanged("expires_at", "not-time");
        rejectChanged("expires_at", MoaSurfaceProgramEvents.timestamp(NOW - 1));
        rejectChanged("expires_at", MoaSurfaceProgramEvents.timestamp(NOW + MoaSurfaceProgramContract.MAX_LIFETIME_MS + 1));
        rejectChanged("issued_at", MoaSurfaceProgramEvents.timestamp(NOW + 31_000));
    }

    @Test public void canonicalJsonAndDigestsAreStableAndStrict() throws Exception {
        JSONObject a = new JSONObject().put("z", new JSONArray().put(true).put(JSONObject.NULL)).put("a", 7).put("s", "x");
        JSONObject b = new JSONObject().put("s", "x").put("a", 7).put("z", new JSONArray().put(true).put(JSONObject.NULL));
        assertEquals(MoaProgramJson.canonical(a), MoaProgramJson.canonical(b));
        assertEquals(MoaProgramJson.sha256(MoaProgramJson.canonical(a)), MoaProgramJson.sha256(MoaProgramJson.canonical(b)));
        assertEquals("null", MoaProgramJson.canonical(null));
        assertEquals("false", MoaProgramJson.canonical(false));
        assertEquals("\"x\"", MoaProgramJson.canonical("x"));
        assertEquals("1.5", MoaProgramJson.canonical(1.5));
        assertEquals(a.toString(), MoaProgramJson.copy(a).toString());
        try { MoaProgramJson.canonical(Double.NaN); fail(); } catch (IllegalArgumentException expected) { assertEquals("invalid_jcs_number", expected.getMessage()); }
        try { MoaProgramJson.canonical(9_007_199_254_740_992L); fail(); } catch (IllegalArgumentException expected) { assertEquals("invalid_jcs_number", expected.getMessage()); }
        assertEquals("{\"a\":1,\"z\":2}", MoaProgramJson.canonical(new JSONObject().put("z", 2).put("a", 1)));
        JSONObject vector = new JSONObject().put("a/b", "slash").put("arr", new JSONArray().put(JSONObject.NULL).put(true).put(false).put(0).put(42))
                .put("ctl", "\u000f").put("n", 9_007_199_254_740_991L).put("€", "euro").put("😀", "astral");
        assertEquals("9af6189a09fc6952309cae21a8e858ac2b4860fb8d59500bdfb5cc9d66165e7c", MoaProgramJson.sha256(MoaProgramJson.canonical(vector)));
        try { MoaProgramJson.canonical(new Object()); fail(); } catch (IllegalArgumentException expected) { assertEquals("unsupported_json_value", expected.getMessage()); }
        JSONObject invalidCopy = new JSONObject() { @Override public String toString() { return "{"; } };
        try { MoaProgramJson.copy(invalidCopy); fail(); } catch (IllegalArgumentException expected) { assertEquals("invalid_json", expected.getMessage()); }
        java.lang.reflect.Constructor<MoaProgramJson> constructor = MoaProgramJson.class.getDeclaredConstructor();
        constructor.setAccessible(true); constructor.newInstance();
    }

    @Test public void catalogAndAdvertisementAreClosedAndDeterministic() throws Exception {
        assertTrue(MoaScriptExecutionCatalog.isRead(MoaScriptExecutionCatalog.OBSERVE));
        assertTrue(MoaScriptExecutionCatalog.isRead(MoaScriptExecutionCatalog.FIND));
        assertFalse(MoaScriptExecutionCatalog.isRead(MoaScriptExecutionCatalog.CLICK));
        assertTrue(MoaScriptExecutionCatalog.isMutation(MoaScriptExecutionCatalog.CLICK));
        assertFalse(MoaScriptExecutionCatalog.isMutation("android.shell.execute"));
        assertFalse(MoaScriptExecutionCatalog.isMutation(MoaScriptExecutionCatalog.OBSERVE));
        assertEquals("read", MoaScriptExecutionCatalog.effectClass(MoaScriptExecutionCatalog.OBSERVE));
        assertEquals("read", MoaScriptExecutionCatalog.effectClass(MoaScriptExecutionCatalog.FIND));
        assertEquals("external_side_effect", MoaScriptExecutionCatalog.effectClass(MoaScriptExecutionCatalog.SET_TEXT));
        assertEquals("external_side_effect", MoaScriptExecutionCatalog.effectClass(MoaScriptExecutionCatalog.CLICK));
        assertFalse(MoaScriptExecutionCatalog.ids().contains(MoaScriptExecutionCatalog.SET_TEXT));
        assertEquals(6, MoaScriptExecutionCatalog.idsJson().length());
        JSONObject descriptor = MoaScriptExecutionCatalog.descriptor();
        assertEquals(MoaScriptExecutionCatalog.sha256(), MoaProgramJson.sha256(MoaProgramJson.canonical(descriptor)));
        assertEquals(6, descriptor.getJSONArray("capabilities").length());
        assertFalse(descriptor.toString().contains(MoaScriptExecutionCatalog.SET_TEXT));
        JSONObject advertisement = MoaScriptExecutionCatalog.advertisement("android_fixture", NOW);
        assertEquals("surface.runtime.advertised", advertisement.getString("type"));
        assertEquals("main", advertisement.getJSONObject("runtime").getString("entrypoint"));
        assertEquals("android_fixture", advertisement.getJSONObject("target").getString("device_id"));
        assertEquals(6, advertisement.getJSONObject("catalog").getJSONArray("capability_ids").length());
    }

    @Test public void receiptsBindDigestsChainAndOmitRawData() throws Exception {
        MoaSurfaceProgramContract.Proposal proposal = MoaSurfaceProgramContract.parse(valid(), "android_fixture", NOW);
        JSONObject input = new JSONObject().put("text", "secret form value");
        JSONObject tool = MoaSurfaceProgramReceipts.toolBound(proposal, "client_fixture", "call_1", 1,
                MoaScriptExecutionCatalog.SET_TEXT, input, "succeeded", "", zeros(), "1".repeat(64), NOW, NOW + 2);
        assertEquals(64, tool.getString("receipt_sha256").length());
        assertEquals(MoaSurfaceProgramReceipts.digestWithoutField(tool, "receipt_sha256"), tool.getString("receipt_sha256"));
        assertFalse(tool.toString().contains("secret form value"));
        JSONArray attempts = new JSONArray().put(tool);
        JSONObject terminal = MoaSurfaceProgramReceipts.terminal(proposal, "client_fixture", "completed", "Done.", zeros(), "", "", attempts, NOW, NOW + 3);
        assertEquals(1, terminal.getJSONObject("tool_attempts").getInt("count"));
        assertEquals(tool.getString("receipt_sha256"), terminal.getJSONObject("tool_attempts").getString("last_receipt_sha256"));
        assertEquals(tool.getString("receipt_sha256"), terminal.getString("previous_receipt_sha256"));
        assertEquals(MoaSurfaceProgramReceipts.digestWithoutField(terminal, "receipt_sha256"), terminal.getString("receipt_sha256"));
        assertFalse(terminal.toString().contains("secret form value"));
        JSONObject failed = MoaSurfaceProgramReceipts.terminal(proposal, "client_fixture", "failed", "Nope", "", "failed", "Nope", new JSONArray(), 0, NOW);
        assertFalse(failed.getJSONObject("error").getString("message").contains("Nope"));
        assertEquals(JSONObject.NULL, failed.get("started_at"));
        assertEquals(JSONObject.NULL, failed.get("previous_receipt_sha256"));
        JSONObject bounded = MoaSurfaceProgramReceipts.terminal(proposal, "client_fixture", "failed", null, "", "failed", "x".repeat(300), new JSONArray(), 0, NOW);
        assertTrue(bounded.getJSONObject("error").getString("message").length() <= 240);
    }

    @Test public void workerAssetIsOfflineFreshRealmWithNarrowBridge() throws Exception {
        String html = new String(java.nio.file.Files.readAllBytes(java.nio.file.Paths.get("src/main/assets/moa_program_runtime.html")), StandardCharsets.UTF_8);
        assertTrue(html.contains("connect-src 'none'"));
        assertTrue(html.contains("new Worker"));
        assertTrue(html.contains("ambient_io_disabled"));
        assertTrue(html.contains("main_not_defined"));
        assertTrue(html.contains("AndroidBridge.call"));
        assertFalse(html.contains("chrome."));
        assertFalse(html.contains("addJavascriptInterface"));
        assertTrue(html.contains("Object.defineProperty(self, \"postMessage\""));
        assertTrue(html.contains("isAuthorityDenial"));
        assertTrue(html.contains("code: \"policy_denied\""));
        assertFalse(html.contains("event.message"));
    }

    @Test public void lifecycleAndClosedReceiptEnumsAreFullyConstructed() throws Exception {
        MoaSurfaceProgramContract.Proposal p = MoaSurfaceProgramContract.parse(valid(), "android_fixture", NOW);
        JSONObject tool = MoaSurfaceProgramReceipts.toolBound(p, "client", "call", 1, MoaScriptExecutionCatalog.OBSERVE,
                new JSONObject(), "succeeded", "", zeros(), null, NOW, NOW + 1);
        JSONObject terminal = MoaSurfaceProgramReceipts.terminal(p, "client", "completed", new JSONArray().put(tool), NOW, NOW + 2, zeros(), null);
        assertEquals("accepted", MoaSurfaceProgramEvents.accepted(p, "client", 1, NOW).getString("kind"));
        assertEquals("started", MoaSurfaceProgramEvents.started(p, "client", 2, NOW).getString("kind"));
        assertEquals("tool_started", MoaSurfaceProgramEvents.toolStarted(p, "client", 3, MoaScriptExecutionCatalog.OBSERVE, "call", NOW).getString("kind"));
        assertEquals("tool_finished", MoaSurfaceProgramEvents.toolFinished(p, "client", 4, MoaScriptExecutionCatalog.OBSERVE, "call", tool, NOW).getString("kind"));
        assertEquals("stopping", MoaSurfaceProgramEvents.stopping(p, "client", 5, "user_stop", NOW).getString("kind"));
        assertEquals("terminal", MoaSurfaceProgramEvents.terminal(p, "client", 6, terminal, NOW).getString("kind"));
        assertTrue(MoaSurfaceProgramEvents.timestamp(NOW).endsWith(".000Z"));

        String[] statuses = {"rejected", "failed", "timed_out", "stopped", "interrupted", "indeterminate"};
        String[] codes = {"stale_state", "tool_failed", "timeout", "policy_revoked", "runtime_interrupted", "indeterminate"};
        for (int i = 0; i < statuses.length; i++) {
            JSONObject receipt = MoaSurfaceProgramReceipts.terminal(p, "client", statuses[i], new JSONArray(), 0, NOW, null, codes[i]);
            assertEquals(statuses[i], receipt.getString("status")); assertEquals(codes[i], receipt.getJSONObject("error").getString("code"));
        }
        assertEquals("proposal_rejected", MoaSurfaceProgramReceipts.terminal(p, "client", "rejected", new JSONArray(), 0, NOW, null, "bad").getJSONObject("error").getString("code"));
        assertEquals("runtime_failed", MoaSurfaceProgramReceipts.terminal(p, "client", "failed", new JSONArray(), 0, NOW, null, "bad").getJSONObject("error").getString("code"));
        assertEquals("user_stop", MoaSurfaceProgramReceipts.terminal(p, "client", "stopped", new JSONArray(), 0, NOW, null, "bad").getJSONObject("error").getString("code"));
        for (String code : new String[]{"proposal_rejected", "policy_denied", "unsupported_profile"}) assertEquals(code, MoaSurfaceProgramReceipts.terminal(p, "client", "rejected", new JSONArray(), 0, NOW, null, code).getJSONObject("error").getString("code"));
        for (String code : new String[]{"runtime_failed", "receipt_failed", "limit_exceeded"}) assertEquals(code, MoaSurfaceProgramReceipts.terminal(p, "client", "failed", new JSONArray(), 0, NOW, null, code).getJSONObject("error").getString("code"));
        for (String code : new String[]{"user_stop", "surface_shutdown"}) assertEquals(code, MoaSurfaceProgramReceipts.terminal(p, "client", "stopped", new JSONArray(), 0, NOW, null, code).getJSONObject("error").getString("code"));
        assertEquals("surface_shutdown", MoaSurfaceProgramReceipts.terminal(p, "client", "interrupted", new JSONArray(), 0, NOW, null, "surface_shutdown").getJSONObject("error").getString("code"));
        try { MoaSurfaceProgramReceipts.terminal(p, "client", "unknown", new JSONArray(), 0, NOW, null, "bad"); fail(); } catch (IllegalStateException expected) { assertTrue(expected.getCause() instanceof IllegalArgumentException); }
        try { MoaSurfaceProgramReceipts.toolBound(p, "client", "call", 1, MoaScriptExecutionCatalog.CLICK, new JSONObject(), "succeeded", "", zeros(), null, NOW, NOW); fail(); } catch (IllegalStateException expected) { assertTrue(expected.getCause() instanceof IllegalArgumentException); }
        try { MoaSurfaceProgramReceipts.toolBound(p, "client", "call", 1, MoaScriptExecutionCatalog.OBSERVE, new JSONObject(), "unknown", "", zeros(), null, NOW, NOW); fail(); } catch (IllegalStateException expected) { assertTrue(expected.getCause() instanceof IllegalArgumentException); }
    }

    static JSONObject valid() throws Exception {
        String source = "async function main(tools) { return await tools.android.accessibility.observe({}); }";
        return new JSONObject()
                .put("version", 1).put("type", "surface.execution.proposed")
                .put("execution_id", "exec_fixture").put("session_id", "session_fixture").put("turn_id", "turn_fixture")
                .put("target", new JSONObject().put("surface_type", "android").put("device_id", "android_fixture"))
                .put("runtime", new JSONObject().put("runtime_id", MoaScriptExecutionCatalog.RUNTIME_ID).put("language", "javascript").put("bridge_version", 1).put("entrypoint", "main"))
                .put("program", new JSONObject().put("source", source).put("sha256", MoaProgramJson.sha256(source)))
                .put("catalog", new JSONObject().put("version", 1).put("sha256", MoaScriptExecutionCatalog.sha256()).put("allowed_capability_ids", new JSONArray(MoaScriptExecutionCatalog.ids())))
                .put("bindings", new JSONObject().put("kind", "android_accessibility").put("observation_id", "obs_fixture").put("observation_generation", 7).put("state_sha256", zeros()).put("package_name", "com.example.fixture").put("window_id", "7"))
                .put("limits", new JSONObject().put("source_bytes", 65536).put("wall_ms", 5000).put("memory_bytes", JSONObject.NULL)
                        .put("tool_calls", 20).put("parallel_calls", 1).put("result_bytes", 4096).put("log_bytes", 1024))
                .put("approval_policy", new JSONObject().put("program", "preauthorized").put("always_ask", new JSONArray()))
                .put("idempotency_key", "idem_fixture").put("issued_at", MoaSurfaceProgramEvents.timestamp(NOW - 1000)).put("expires_at", MoaSurfaceProgramEvents.timestamp(NOW + 60_000));
    }

    static String zeros() { return "0".repeat(64); }
    private static void rejectChanged(String key, Object value) throws Exception { JSONObject envelope = valid(); envelope.put(key, value); rejected(envelope); }
    private static JSONObject changed(JSONObject input, String key, Object value) throws Exception { input.put(key, value); return input; }
    private static void rejectNested(String object, String key, Object value) throws Exception { JSONObject envelope = valid(); envelope.getJSONObject(object).put(key, value); rejected(envelope); }
    private static void rejectLimit(String key, Object value) throws Exception { rejectNested("limits", key, value); }
    private static void rejected(JSONObject input) { try { MoaSurfaceProgramContract.parse(input, "android_fixture", NOW); fail("accepted " + input); } catch (MoaSurfaceProgramContract.Rejected expected) { assertFalse(expected.code.isEmpty()); } }
    private static String rejection(JSONObject input) { try { MoaSurfaceProgramContract.parse(input, "android_fixture", NOW); fail("accepted " + input); return ""; } catch (MoaSurfaceProgramContract.Rejected expected) { return expected.code; } }
}
