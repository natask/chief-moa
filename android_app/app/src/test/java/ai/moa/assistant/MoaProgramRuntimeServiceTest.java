package ai.moa.assistant;

import android.content.Context;
import android.content.ContextWrapper;
import android.content.ServiceConnection;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Message;
import android.os.Messenger;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowLooper;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public final class MoaProgramRuntimeServiceTest {
    @Test public void dedicatedServiceBoundsClosesAndForwardsProtocol() throws Exception {
        MoaProgramRuntimeService service = Robolectric.buildService(MoaProgramRuntimeService.class).create().get();
        assertNotNull(service.onBind(null));
        assertTrue(service.getPackageManager().getServiceInfo(new android.content.ComponentName(service, MoaProgramRuntimeService.class), 0).processName.endsWith(":moa_program_runtime"));

        Method parse = method("parseAllowedCapabilities", String.class);
        assertEquals(2, ((JSONArray) parse.invoke(null, "[\"a\",\"b\"]")).length());
        assertNull(parse.invoke(null, "bad"));
        assertNull(parse.invoke(null, "[1]"));
        assertNull(parse.invoke(null, new Object[]{null}));

        Method close = method("closeTerminalPayload", String.class);
        assertTrue(((String) close.invoke(null, "{\"type\":\"terminal\",\"ok\":true,\"result\":7}")).contains("\"result\":7"));
        for (String bad : new String[]{null, "bad", "{}", "{\"type\":\"wrong\",\"ok\":true}", "{\"type\":\"terminal\",\"ok\":\"true\"}", "{\"type\":\"terminal\",\"ok\":false}"})
            assertTrue(((String) close.invoke(null, new Object[]{bad})).contains("runtime_failed"));
        assertTrue(((String) close.invoke(null, "{\"type\":\"terminal\",\"ok\":true}")).contains("\"result\":null"));
        assertTrue(((String) close.invoke(null, "{\"type\":\"terminal\",\"ok\":false,\"code\":\"limit_exceeded\"}")).contains("limit_exceeded"));
        assertTrue(((String) close.invoke(null, "{\"type\":\"terminal\",\"ok\":false,\"code\":\"policy_denied\"}")).contains("policy_denied"));
        assertTrue(((String) close.invoke(null, new JSONObject().put("type", "terminal").put("ok", true).put("result", "x".repeat(131073)).toString())).contains("runtime_failed"));

        Method bounded = method("isBounded", String.class);
        assertEquals(false, bounded.invoke(null, new Object[]{null}));
        assertEquals(true, bounded.invoke(null, "fixture"));
        assertEquals(false, bounded.invoke(null, "x".repeat(131073)));
        Method asset = method("readAsset", String.class);
        assertTrue(((String) asset.invoke(service, "moa_program_runtime.html")).contains("new Worker"));
        try { asset.invoke(service, "missing"); fail(); } catch (java.lang.reflect.InvocationTargetException expected) { assertTrue(expected.getCause() instanceof IllegalStateException); }

        List<Message> received = new ArrayList<>();
        Messenger reply = new Messenger(new Handler(Looper.getMainLooper(), message -> { received.add(Message.obtain(message)); return true; }));
        Message start = Message.obtain(null, MoaProgramRuntimeService.START); start.replyTo = reply;
        Bundle startData = startData("fixture_nonce_123456", "async function main(){return 1}"); start.setData(startData);
        new Messenger(service.onBind(null)).send(start); ShadowLooper.runUiThreadTasks();

        Field bridgeField = MoaProgramRuntimeService.class.getDeclaredField("bridge"); bridgeField.setAccessible(true);
        Object bridge = bridgeField.get(service); assertNotNull(bridge);
        Method ready = bridge.getClass().getDeclaredMethod("ready"); ready.setAccessible(true); ready.invoke(bridge); ShadowLooper.runUiThreadTasks();
        Method call = bridge.getClass().getDeclaredMethod("call", String.class); call.setAccessible(true); call.invoke(bridge, "{\"call_id\":\"c\"}"); ShadowLooper.runUiThreadTasks();
        assertTrue(received.stream().anyMatch(m -> m.what == MoaProgramRuntimeService.READY));
        assertTrue(received.stream().anyMatch(m -> m.what == MoaProgramRuntimeService.CALL));

        Message response = Message.obtain(null, MoaProgramRuntimeService.RESPONSE); Bundle responseData = new Bundle(); responseData.putString("execution_nonce", "fixture_nonce_123456"); responseData.putLong("execution_generation", 10); responseData.putString("payload", "{\"type\":\"response\",\"call_id\":\"c\",\"ok\":true}"); response.setData(responseData);
        new Messenger(service.onBind(null)).send(response); ShadowLooper.runUiThreadTasks();
        Method deliverResponse = method("deliverResponse", Bundle.class);
        deliverResponse.invoke(service, new Object[]{null});
        deliverResponse.invoke(service, new Bundle());
        Message badResponse = Message.obtain(null, MoaProgramRuntimeService.RESPONSE); Bundle badData = new Bundle(); badData.putString("execution_nonce", "fixture_nonce_123456"); badData.putLong("execution_generation", 10); badData.putString("payload", "bad"); badResponse.setData(badData); new Messenger(service.onBind(null)).send(badResponse); ShadowLooper.runUiThreadTasks();
        call.invoke(bridge, "stale"); ready.invoke(bridge); ShadowLooper.runUiThreadTasks();
        startData.putLong("execution_generation", 11); Message restart = Message.obtain(null, MoaProgramRuntimeService.START); restart.replyTo = reply; restart.setData(startData); new Messenger(service.onBind(null)).send(restart); ShadowLooper.runUiThreadTasks(); bridge = bridgeField.get(service);
        Field startConfig = bridge.getClass().getDeclaredField("startConfig"); startConfig.setAccessible(true); startConfig.set(bridge, null);
        ready = bridge.getClass().getDeclaredMethod("ready"); ready.setAccessible(true); ready.invoke(bridge); ShadowLooper.runUiThreadTasks();
        call = bridge.getClass().getDeclaredMethod("call", String.class); call.setAccessible(true); call.invoke(bridge, "x".repeat(131073)); ShadowLooper.runUiThreadTasks();
        startData.putLong("execution_generation", 12); Message restartAgain = Message.obtain(null, MoaProgramRuntimeService.START); restartAgain.replyTo = reply; restartAgain.setData(startData); new Messenger(service.onBind(null)).send(restartAgain); ShadowLooper.runUiThreadTasks(); bridge = bridgeField.get(service);
        Object successorBridge = bridge;
        Bundle staleStartData = startData("stale_nonce_123456", "async function main(){return 'stale'}"); staleStartData.putLong("execution_generation", 11);
        Message staleStart = Message.obtain(null, MoaProgramRuntimeService.START); staleStart.replyTo = reply; staleStart.setData(staleStartData); new Messenger(service.onBind(null)).send(staleStart); ShadowLooper.runUiThreadTasks();
        assertSame(successorBridge, bridgeField.get(service));
        Method finish = bridge.getClass().getDeclaredMethod("finish", String.class); finish.setAccessible(true); finish.invoke(bridge, "{\"type\":\"terminal\",\"ok\":true,\"result\":null}"); ShadowLooper.runUiThreadTasks();
        assertTrue(received.stream().anyMatch(m -> m.what == MoaProgramRuntimeService.FINISH));
        finish.invoke(bridge, "{\"type\":\"terminal\",\"ok\":true,\"result\":null}"); ShadowLooper.runUiThreadTasks();
        service.onDestroy();
    }

    @Test public void invalidServiceMessagesFailClosed() throws Exception {
        MoaProgramRuntimeService service = Robolectric.buildService(MoaProgramRuntimeService.class).create().get();
        Messenger incoming = new Messenger(service.onBind(null));
        incoming.send(Message.obtain(null, 999));
        Message start = Message.obtain(null, MoaProgramRuntimeService.START); start.replyTo = new Messenger(new Handler(Looper.getMainLooper())); start.setData(new Bundle()); incoming.send(start);
        Message noReply = Message.obtain(null, MoaProgramRuntimeService.START); noReply.setData(new Bundle()); incoming.send(noReply);
        Message nullData = Message.obtain(null, MoaProgramRuntimeService.START); nullData.replyTo = start.replyTo; incoming.send(nullData);
        Message response = Message.obtain(null, MoaProgramRuntimeService.RESPONSE); response.setData(new Bundle()); incoming.send(response);
        incoming.send(Message.obtain(null, MoaProgramRuntimeService.STOP));
        ShadowLooper.runUiThreadTasks();
        Method startRuntime = method("startRuntime", Bundle.class, Messenger.class);
        Messenger reply = new Messenger(new Handler(Looper.getMainLooper()));
        Bundle invalidAllowed = startData("fixture_nonce_123456", "ok"); invalidAllowed.putString("allowed_capability_ids", "bad"); startRuntime.invoke(service, invalidAllowed, reply);
        Bundle oversizedSource = startData("fixture_nonce_123456", "x".repeat(131073)); startRuntime.invoke(service, oversizedSource, reply);
        Bundle oversizedAllowed = startData("fixture_nonce_123456", "ok"); oversizedAllowed.putString("allowed_capability_ids", "x".repeat(131073)); startRuntime.invoke(service, oversizedAllowed, reply);
        startRuntime.invoke(service, null, reply); startRuntime.invoke(service, new Bundle(), null);
        Method finishFailure = method("finishWithFailure"); finishFailure.invoke(service);
        service.onDestroy();
    }

    @Test @Config(sdk = 26) public void unsupportedApiNeverStartsRuntime() throws Exception {
        MoaProgramRuntimeService service = Robolectric.buildService(MoaProgramRuntimeService.class).create().get();
        Bundle data = startData("fixture_nonce_123456", "ok");
        method("startRuntime", Bundle.class, Messenger.class).invoke(service, data, new Messenger(new Handler(Looper.getMainLooper())));
        Field webView = MoaProgramRuntimeService.class.getDeclaredField("webView"); webView.setAccessible(true); assertNull(webView.get(service)); service.onDestroy();
    }

    @Test public void serviceRejectsStaleGenerationsBeforeTouchingActiveRealm() throws Exception {
        MoaProgramRuntimeService service = Robolectric.buildService(MoaProgramRuntimeService.class).create().get();
        Messenger reply = new Messenger(new Handler(Looper.getMainLooper()));
        Method start = method("startRuntime", Bundle.class, Messenger.class);
        Bundle active = startData("active_nonce_123456", "async function main(){return 1}"); active.putLong("execution_generation", 100);
        start.invoke(service, active, reply);
        Field bridgeField = MoaProgramRuntimeService.class.getDeclaredField("bridge"); bridgeField.setAccessible(true);
        Object bridge = bridgeField.get(service); assertNotNull(bridge);

        for (Bundle invalid : new Bundle[]{
                startData("short", "ok"), startData("valid_nonce_123456", null),
                startData("valid_nonce_123456", "ok"), startData("valid_nonce_123456", "ok")}) {
            if (invalid.getString("execution_nonce").equals("valid_nonce_123456") && invalid.getString("source") != null) {
                if (invalid.getLong("execution_generation") == 10) invalid.putInt("log_bytes", -1);
            }
            start.invoke(service, invalid, reply);
            assertSame(bridge, bridgeField.get(service));
        }
        Bundle zeroGeneration = startData("valid_nonce_123456", "ok"); zeroGeneration.putLong("execution_generation", 0); start.invoke(service, zeroGeneration, reply);
        Bundle hugeLogs = startData("valid_nonce_123456", "ok"); hugeLogs.putLong("execution_generation", 101); hugeLogs.putInt("log_bytes", 32769); start.invoke(service, hugeLogs, reply);
        assertSame(bridge, bridgeField.get(service));

        Method activeMethod = MoaProgramRuntimeService.class.getDeclaredMethod("isActive", bridge.getClass()); activeMethod.setAccessible(true);
        assertEquals(true, activeMethod.invoke(service, bridge)); assertEquals(false, activeMethod.invoke(service, new Object[]{null}));
        Messenger incoming = new Messenger(service.onBind(null));
        Message staleStop = message("active_nonce_123456", 99, MoaProgramRuntimeService.STOP, null); incoming.send(staleStop);
        Message wrongStop = message("wrong_nonce_123456", 100, MoaProgramRuntimeService.STOP, null); incoming.send(wrongStop); ShadowLooper.runUiThreadTasks();
        assertSame(bridge, bridgeField.get(service));
        Message currentStop = message("active_nonce_123456", 100, MoaProgramRuntimeService.STOP, null); incoming.send(currentStop); ShadowLooper.runUiThreadTasks();
        assertNull(bridgeField.get(service)); assertEquals(false, activeMethod.invoke(service, bridge));
        service.onDestroy();
    }

    @Test public void serviceEngineBindsStopsAndHandlesMessages() throws Exception {
        Context context = RuntimeEnvironment.getApplication();
        MoaWebViewProgramRuntime.ServiceEngine engine = new MoaWebViewProgramRuntime.ServiceEngine(context);
        List<String> calls = new ArrayList<>(), finishes = new ArrayList<>();
        engine.start("engine_nonce_123456", 20, "async function main(){return null}", new JSONArray(), 12, new MoaWebViewProgramRuntime.EngineListener() {
            public void call(String nonce, long generation, String payload) { calls.add(payload); }
            public void finish(String nonce, long generation, String payload) { finishes.add(payload); }
        });
        ShadowLooper.runUiThreadTasks();
        engine.handleMessage(message(MoaProgramRuntimeService.CALL, "call"));
        engine.handleMessage(message(MoaProgramRuntimeService.FINISH, "finish"));
        assertTrue(engine.handleMessage(message(999, "ignored")));
        engine.respond("engine_nonce_123456", 20, new JSONObject()); engine.onServiceDisconnected(null); engine.stop("engine_nonce_123456", 20); engine.stop("engine_nonce_123456", 20);
        assertTrue(engine.handleMessage(message(MoaProgramRuntimeService.CALL, "ignored")));
        assertEquals(List.of("call"), calls); assertTrue(finishes.contains("finish")); assertTrue(finishes.stream().anyMatch(value -> value.contains("runtime_failed")));

        BindingContext binding = new BindingContext(context);
        MoaWebViewProgramRuntime.ServiceEngine connected = new MoaWebViewProgramRuntime.ServiceEngine(binding);
        connected.start("connected_nonce_123456", 30, "source", new JSONArray(), 44, new MoaWebViewProgramRuntime.EngineListener() { public void call(String nonce, long generation, String payload) {} public void finish(String nonce, long generation, String payload) { finishes.add(payload); } });
        assertTrue(binding.bound); List<Integer> sent = new ArrayList<>();
        Messenger remote = new Messenger(new Handler(Looper.getMainLooper(), message -> { sent.add(message.what); return true; }));
        binding.connection.onServiceConnected(null, remote.getBinder()); connected.respond("connected_nonce_123456", 30, new JSONObject()); connected.stop("connected_nonce_123456", 30); ShadowLooper.runUiThreadTasks();
        assertTrue(sent.contains(MoaProgramRuntimeService.START)); assertTrue(sent.contains(MoaProgramRuntimeService.RESPONSE));

        BindingContext replacementBinding = new BindingContext(context);
        MoaWebViewProgramRuntime.ServiceEngine replacement = new MoaWebViewProgramRuntime.ServiceEngine(replacementBinding);
        List<String> replacementCalls = new ArrayList<>();
        replacement.start("current_nonce_123456", 40, "source", new JSONArray(), 8, new MoaWebViewProgramRuntime.EngineListener() {
            public void call(String nonce, long generation, String payload) { replacementCalls.add(payload); }
            public void finish(String nonce, long generation, String payload) { replacementCalls.add("finish:" + payload); }
        });
        replacement.handleMessage(message("stale_nonce_123456", MoaProgramRuntimeService.CALL, "stale"));
        replacement.handleMessage(message("current_nonce_123456", 39, MoaProgramRuntimeService.CALL, "stale-generation"));
        replacement.handleMessage(message("current_nonce_123456", MoaProgramRuntimeService.CALL, "current"));
        assertEquals(List.of("current"), replacementCalls);
        replacement.respond("wrong_nonce_123456", 40, new JSONObject());
        replacement.respond("current_nonce_123456", 39, new JSONObject());
        replacement.stop("wrong_nonce_123456", 40);
        replacement.stop("current_nonce_123456", 39);
        ServiceConnection staleConnection = replacementBinding.connection;
        replacement.start("successor_nonce_123456", 41, "source", new JSONArray(), 8, new MoaWebViewProgramRuntime.EngineListener() {
            public void call(String nonce, long generation, String payload) { replacementCalls.add("successor:" + payload); }
            public void finish(String nonce, long generation, String payload) { replacementCalls.add("successor-finish"); }
        });
        staleConnection.onServiceConnected(null, remote.getBinder()); staleConnection.onServiceDisconnected(null);
        assertEquals(List.of("current"), replacementCalls);
        Field connectionGenerationField = MoaWebViewProgramRuntime.ServiceEngine.class.getDeclaredField("connectionGeneration"); connectionGenerationField.setAccessible(true);
        long currentBindingGeneration = connectionGenerationField.getLong(replacement);
        Method connectedMethod = MoaWebViewProgramRuntime.ServiceEngine.class.getDeclaredMethod("connected", long.class, String.class, long.class, android.os.IBinder.class); connectedMethod.setAccessible(true);
        Method disconnectedMethod = MoaWebViewProgramRuntime.ServiceEngine.class.getDeclaredMethod("disconnected", long.class, String.class, long.class); disconnectedMethod.setAccessible(true);
        connectedMethod.invoke(replacement, currentBindingGeneration, null, 41L, remote.getBinder());
        connectedMethod.invoke(replacement, currentBindingGeneration, "wrong_nonce_123456", 41L, remote.getBinder());
        connectedMethod.invoke(replacement, currentBindingGeneration, "successor_nonce_123456", 40L, remote.getBinder());
        replacementBinding.connection.onServiceConnected(null, remote.getBinder());
        replacement.respond(null, 41, new JSONObject());
        replacement.respond("wrong_nonce_123456", 41, new JSONObject());
        replacement.respond("successor_nonce_123456", 40, new JSONObject());
        disconnectedMethod.invoke(replacement, currentBindingGeneration, null, 41L);
        disconnectedMethod.invoke(replacement, currentBindingGeneration, "wrong_nonce_123456", 41L);
        disconnectedMethod.invoke(replacement, currentBindingGeneration, "successor_nonce_123456", 40L);
        replacementBinding.connection.onServiceDisconnected(null);
        assertTrue(replacementCalls.contains("successor-finish"));
        replacement.stop("successor_nonce_123456", 41);

        BindingContext refused = new BindingContext(context); refused.bindResult = false;
        MoaWebViewProgramRuntime.ServiceEngine unbound = new MoaWebViewProgramRuntime.ServiceEngine(refused);
        List<String> refusedFinish = new ArrayList<>();
        unbound.start("refused_nonce_123456", 50, "source", new JSONArray(), 0, new MoaWebViewProgramRuntime.EngineListener() {
            public void call(String nonce, long generation, String payload) {}
            public void finish(String nonce, long generation, String payload) { refusedFinish.add(payload); }
        });
        assertEquals(1, refusedFinish.size()); unbound.stop("refused_nonce_123456", 50);
    }

    private static final class BindingContext extends ContextWrapper {
        ServiceConnection connection; boolean bound; boolean bindResult = true;
        BindingContext(Context base) { super(base); }
        @Override public boolean bindService(android.content.Intent intent, ServiceConnection connection, int flags) { this.connection = connection; bound = bindResult; return bindResult; }
        @Override public void unbindService(ServiceConnection connection) { bound = false; }
    }

    private static Message message(int what, String payload) { return message("engine_nonce_123456", what, payload); }
    private static Message message(String nonce, int what, String payload) { return message(nonce, "engine_nonce_123456".equals(nonce) ? 20 : "current_nonce_123456".equals(nonce) ? 40 : 39, what, payload); }
    private static Message message(String nonce, long generation, int what, String payload) { Message m = Message.obtain(null, what); Bundle b = new Bundle(); b.putString("execution_nonce", nonce); b.putLong("execution_generation", generation); if (payload != null) b.putString("payload", payload); m.setData(b); return m; }
    private static Bundle startData(String nonce, String source) { Bundle data = new Bundle(); data.putString("execution_nonce", nonce); data.putLong("execution_generation", 10); data.putString("source", source); data.putString("allowed_capability_ids", "[]"); data.putInt("log_bytes", 1024); return data; }
    private static Method method(String name, Class<?>... types) throws Exception { Method method = MoaProgramRuntimeService.class.getDeclaredMethod(name, types); method.setAccessible(true); return method; }
}
