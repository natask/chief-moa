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
        Bundle startData = new Bundle(); startData.putString("source", "async function main(){return 1}"); startData.putString("allowed_capability_ids", "[]"); start.setData(startData);
        new Messenger(service.onBind(null)).send(start); ShadowLooper.runUiThreadTasks();

        Field bridgeField = MoaProgramRuntimeService.class.getDeclaredField("bridge"); bridgeField.setAccessible(true);
        Object bridge = bridgeField.get(service); assertNotNull(bridge);
        Method ready = bridge.getClass().getDeclaredMethod("ready"); ready.setAccessible(true); ready.invoke(bridge); ShadowLooper.runUiThreadTasks();
        Method call = bridge.getClass().getDeclaredMethod("call", String.class); call.setAccessible(true); call.invoke(bridge, "{\"call_id\":\"c\"}"); ShadowLooper.runUiThreadTasks();
        assertTrue(received.stream().anyMatch(m -> m.what == MoaProgramRuntimeService.READY));
        assertTrue(received.stream().anyMatch(m -> m.what == MoaProgramRuntimeService.CALL));

        Message response = Message.obtain(null, MoaProgramRuntimeService.RESPONSE); Bundle responseData = new Bundle(); responseData.putString("payload", "{\"type\":\"response\",\"call_id\":\"c\",\"ok\":true}"); response.setData(responseData);
        new Messenger(service.onBind(null)).send(response); ShadowLooper.runUiThreadTasks();
        Method deliverResponse = method("deliverResponse", Bundle.class);
        deliverResponse.invoke(service, new Object[]{null});
        deliverResponse.invoke(service, new Bundle());
        Message badResponse = Message.obtain(null, MoaProgramRuntimeService.RESPONSE); Bundle badData = new Bundle(); badData.putString("payload", "bad"); badResponse.setData(badData); new Messenger(service.onBind(null)).send(badResponse); ShadowLooper.runUiThreadTasks();
        call.invoke(bridge, "stale"); ready.invoke(bridge); ShadowLooper.runUiThreadTasks();
        Message restart = Message.obtain(null, MoaProgramRuntimeService.START); restart.replyTo = reply; restart.setData(startData); new Messenger(service.onBind(null)).send(restart); ShadowLooper.runUiThreadTasks(); bridge = bridgeField.get(service);
        Field startConfig = bridge.getClass().getDeclaredField("startConfig"); startConfig.setAccessible(true); startConfig.set(bridge, null);
        ready = bridge.getClass().getDeclaredMethod("ready"); ready.setAccessible(true); ready.invoke(bridge); ShadowLooper.runUiThreadTasks();
        call = bridge.getClass().getDeclaredMethod("call", String.class); call.setAccessible(true); call.invoke(bridge, "x".repeat(131073)); ShadowLooper.runUiThreadTasks();
        Message restartAgain = Message.obtain(null, MoaProgramRuntimeService.START); restartAgain.replyTo = reply; restartAgain.setData(startData); new Messenger(service.onBind(null)).send(restartAgain); ShadowLooper.runUiThreadTasks(); bridge = bridgeField.get(service);
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
        Bundle invalidAllowed = new Bundle(); invalidAllowed.putString("source", "ok"); invalidAllowed.putString("allowed_capability_ids", "bad"); startRuntime.invoke(service, invalidAllowed, reply);
        Bundle oversizedSource = new Bundle(); oversizedSource.putString("source", "x".repeat(131073)); oversizedSource.putString("allowed_capability_ids", "[]"); startRuntime.invoke(service, oversizedSource, reply);
        Bundle oversizedAllowed = new Bundle(); oversizedAllowed.putString("source", "ok"); oversizedAllowed.putString("allowed_capability_ids", "x".repeat(131073)); startRuntime.invoke(service, oversizedAllowed, reply);
        startRuntime.invoke(service, null, reply); startRuntime.invoke(service, new Bundle(), null);
        Method finishFailure = method("finishWithFailure"); finishFailure.invoke(service);
        service.onDestroy();
    }

    @Test @Config(sdk = 26) public void unsupportedApiNeverStartsRuntime() throws Exception {
        MoaProgramRuntimeService service = Robolectric.buildService(MoaProgramRuntimeService.class).create().get();
        Bundle data = new Bundle(); data.putString("source", "ok"); data.putString("allowed_capability_ids", "[]");
        method("startRuntime", Bundle.class, Messenger.class).invoke(service, data, new Messenger(new Handler(Looper.getMainLooper())));
        Field webView = MoaProgramRuntimeService.class.getDeclaredField("webView"); webView.setAccessible(true); assertNull(webView.get(service)); service.onDestroy();
    }

    @Test public void serviceEngineBindsStopsAndHandlesMessages() throws Exception {
        Context context = RuntimeEnvironment.getApplication();
        MoaWebViewProgramRuntime.ServiceEngine engine = new MoaWebViewProgramRuntime.ServiceEngine(context);
        List<String> calls = new ArrayList<>(), finishes = new ArrayList<>();
        engine.start("async function main(){return null}", new JSONArray(), new MoaWebViewProgramRuntime.EngineListener() {
            public void call(String payload) { calls.add(payload); }
            public void finish(String payload) { finishes.add(payload); }
        });
        ShadowLooper.runUiThreadTasks();
        engine.handleMessage(message(MoaProgramRuntimeService.CALL, "call"));
        engine.handleMessage(message(MoaProgramRuntimeService.FINISH, "finish"));
        assertTrue(engine.handleMessage(message(999, "ignored")));
        engine.respond(new JSONObject()); engine.onServiceDisconnected(null); engine.stop(); engine.stop();
        assertTrue(engine.handleMessage(message(MoaProgramRuntimeService.CALL, "ignored")));
        assertEquals(List.of("call"), calls); assertTrue(finishes.contains("finish")); assertTrue(finishes.stream().anyMatch(value -> value.contains("runtime_failed")));

        BindingContext binding = new BindingContext(context);
        MoaWebViewProgramRuntime.ServiceEngine connected = new MoaWebViewProgramRuntime.ServiceEngine(binding);
        connected.start("source", new JSONArray(), new MoaWebViewProgramRuntime.EngineListener() { public void call(String payload) {} public void finish(String payload) { finishes.add(payload); } });
        assertTrue(binding.bound); List<Integer> sent = new ArrayList<>();
        Messenger remote = new Messenger(new Handler(Looper.getMainLooper(), message -> { sent.add(message.what); return true; }));
        binding.connection.onServiceConnected(null, remote.getBinder()); connected.respond(new JSONObject()); connected.stop(); ShadowLooper.runUiThreadTasks();
        assertTrue(sent.contains(MoaProgramRuntimeService.START)); assertTrue(sent.contains(MoaProgramRuntimeService.RESPONSE));
    }

    private static final class BindingContext extends ContextWrapper {
        ServiceConnection connection; boolean bound;
        BindingContext(Context base) { super(base); }
        @Override public boolean bindService(android.content.Intent intent, ServiceConnection connection, int flags) { this.connection = connection; bound = true; return true; }
        @Override public void unbindService(ServiceConnection connection) { bound = false; }
    }

    private static Message message(int what, String payload) { Message m = Message.obtain(null, what); Bundle b = new Bundle(); b.putString("payload", payload); m.setData(b); return m; }
    private static Method method(String name, Class<?>... types) throws Exception { Method method = MoaProgramRuntimeService.class.getDeclaredMethod(name, types); method.setAccessible(true); return method; }
}
