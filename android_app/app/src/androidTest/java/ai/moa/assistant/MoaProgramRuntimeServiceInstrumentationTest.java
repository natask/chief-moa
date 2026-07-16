package ai.moa.assistant;

import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.Message;
import android.os.Messenger;
import android.os.SystemClock;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.json.JSONObject;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/** Dedicated-emulator proof for the real isolated Messenger/WebView worker. */
@RunWith(AndroidJUnit4.class)
public final class MoaProgramRuntimeServiceInstrumentationTest {
    private static final String FIRST_NONCE = "fixture_first_nonce_0001";
    private static final String SECOND_NONCE = "fixture_second_nonce_0002";
    private static final String THIRD_NONCE = "fixture_third_nonce_0003";

    @Test
    public void blockedWorkerDoesNotBlockWatchdogReplacementAndStaleNonceCannotStopSuccessor()
            throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        CountDownLatch connected = new CountDownLatch(1);
        CountDownLatch firstReady = new CountDownLatch(1);
        CountDownLatch secondFinished = new CountDownLatch(1);
        CountDownLatch thirdReady = new CountDownLatch(1);
        CountDownLatch thirdCall = new CountDownLatch(1);
        CountDownLatch thirdFinished = new CountDownLatch(1);
        AtomicBoolean mainWatchdogRan = new AtomicBoolean(false);
        AtomicReference<String> secondTerminal = new AtomicReference<>();
        AtomicReference<String> thirdTerminal = new AtomicReference<>();
        AtomicReference<String> thirdCallId = new AtomicReference<>();
        long firstGeneration = SystemClock.elapsedRealtimeNanos();
        long secondGeneration = firstGeneration + 1L;
        long thirdGeneration = firstGeneration + 2L;

        Messenger replies = new Messenger(new Handler(Looper.getMainLooper(), message -> {
            String nonce = message.getData().getString(MoaProgramRuntimeService.KEY_EXECUTION_NONCE, "");
            long generation = message.getData().getLong(
                    MoaProgramRuntimeService.KEY_EXECUTION_GENERATION, -1L);
            if (message.what == MoaProgramRuntimeService.READY
                    && FIRST_NONCE.equals(nonce) && firstGeneration == generation) {
                firstReady.countDown();
            } else if (message.what == MoaProgramRuntimeService.FINISH
                    && SECOND_NONCE.equals(nonce) && secondGeneration == generation) {
                secondTerminal.set(message.getData().getString(MoaProgramRuntimeService.KEY_PAYLOAD, ""));
                secondFinished.countDown();
            } else if (message.what == MoaProgramRuntimeService.READY
                    && THIRD_NONCE.equals(nonce) && thirdGeneration == generation) {
                thirdReady.countDown();
            } else if (message.what == MoaProgramRuntimeService.CALL
                    && THIRD_NONCE.equals(nonce) && thirdGeneration == generation) {
                try {
                    thirdCallId.set(new JSONObject(message.getData().getString(
                            MoaProgramRuntimeService.KEY_PAYLOAD, "")).getString("call_id"));
                    thirdCall.countDown();
                } catch (Exception invalidCall) {
                    throw new AssertionError("successor emitted an invalid call", invalidCall);
                }
            } else if (message.what == MoaProgramRuntimeService.FINISH
                    && THIRD_NONCE.equals(nonce) && thirdGeneration == generation) {
                thirdTerminal.set(message.getData().getString(MoaProgramRuntimeService.KEY_PAYLOAD, ""));
                thirdFinished.countDown();
            }
            return true;
        }));

        Messenger[] service = new Messenger[1];
        ServiceConnection connection = new ServiceConnection() {
            @Override public void onServiceConnected(ComponentName name, IBinder binder) {
                service[0] = new Messenger(binder);
                connected.countDown();
            }
            @Override public void onServiceDisconnected(ComponentName name) {
                service[0] = null;
            }
        };

        assertTrue(context.bindService(
                new Intent(context, MoaProgramRuntimeService.class),
                connection,
                Context.BIND_AUTO_CREATE));
        try {
            assertTrue("isolated runtime service did not bind", connected.await(10, TimeUnit.SECONDS));
            assertNotNull(service[0]);

            sendStart(service[0], replies, FIRST_NONCE, firstGeneration,
                    "async function main(){while(true){}};", "[]");
            assertTrue("blocked worker never became ready", firstReady.await(10, TimeUnit.SECONDS));

            new Handler(Looper.getMainLooper()).postDelayed(() -> {
                mainWatchdogRan.set(true);
                sendStart(service[0], replies, SECOND_NONCE, secondGeneration,
                        "async function main(){return {fixture:'replacement_succeeded'}};", "[]");
            }, 250L);
            assertTrue("replacement did not finish", secondFinished.await(15, TimeUnit.SECONDS));
            assertTrue("main-process watchdog was not responsive", mainWatchdogRan.get());
            assertTrue("replacement did not complete successfully",
                    secondTerminal.get().contains("\"ok\":true")
                            && secondTerminal.get().contains("replacement_succeeded"));

            sendStart(service[0], replies, THIRD_NONCE, thirdGeneration,
                    "async function main(tools){return await tools.android.accessibility.observe({})};",
                    "[\"android.accessibility.observe\"]");
            assertTrue("successor never became ready", thirdReady.await(10, TimeUnit.SECONDS));
            assertTrue("successor never emitted its bound call", thirdCall.await(10, TimeUnit.SECONDS));
            sendStart(service[0], replies, SECOND_NONCE, secondGeneration,
                    "async function main(){return 'stale_start_was_accepted'};", "[]");
            sendStop(service[0], SECOND_NONCE, secondGeneration);
            sendResponse(service[0], SECOND_NONCE, secondGeneration,
                    new JSONObject().put("type", "response")
                            .put("call_id", thirdCallId.get())
                            .put("ok", true)
                            .put("data", new JSONObject().put("fixture", "stale_response_was_accepted"))
                            .toString());
            assertTrue("stale response incorrectly completed the live call",
                    !thirdFinished.await(500, TimeUnit.MILLISECONDS));
            sendResponse(service[0], THIRD_NONCE, thirdGeneration,
                    new JSONObject().put("type", "response")
                            .put("call_id", thirdCallId.get())
                            .put("ok", true)
                            .put("data", new JSONObject().put("fixture", "successor_alive"))
                            .toString());
            assertTrue("stale nonce terminated the successor", thirdFinished.await(10, TimeUnit.SECONDS));
            assertTrue("successor did not complete after stale messages",
                    thirdTerminal.get().contains("\"ok\":true")
                            && thirdTerminal.get().contains("successor_alive"));
        } finally {
            Messenger active = service[0];
            if (active != null) sendStop(active, THIRD_NONCE, thirdGeneration);
            context.unbindService(connection);
        }
    }

    private static void sendStart(
            Messenger service,
            Messenger replies,
            String nonce,
            long generation,
            String source,
            String allowedCapabilities
    ) {
        Message start = Message.obtain(null, MoaProgramRuntimeService.START);
        Bundle data = new Bundle();
        data.putString(MoaProgramRuntimeService.KEY_EXECUTION_NONCE, nonce);
        data.putLong(MoaProgramRuntimeService.KEY_EXECUTION_GENERATION, generation);
        data.putString(MoaProgramRuntimeService.KEY_SOURCE, source);
        data.putString(MoaProgramRuntimeService.KEY_ALLOWED_CAPABILITY_IDS, allowedCapabilities);
        data.putInt(MoaProgramRuntimeService.KEY_LOG_BYTES, 0);
        start.setData(data);
        start.replyTo = replies;
        send(service, start);
    }

    private static void sendStop(Messenger service, String nonce, long generation) {
        Message stop = Message.obtain(null, MoaProgramRuntimeService.STOP);
        Bundle data = new Bundle();
        data.putString(MoaProgramRuntimeService.KEY_EXECUTION_NONCE, nonce);
        data.putLong(MoaProgramRuntimeService.KEY_EXECUTION_GENERATION, generation);
        stop.setData(data);
        send(service, stop);
    }

    private static void sendResponse(
            Messenger service,
            String nonce,
            long generation,
            String payload
    ) {
        Message response = Message.obtain(null, MoaProgramRuntimeService.RESPONSE);
        Bundle data = new Bundle();
        data.putString(MoaProgramRuntimeService.KEY_EXECUTION_NONCE, nonce);
        data.putLong(MoaProgramRuntimeService.KEY_EXECUTION_GENERATION, generation);
        data.putString(MoaProgramRuntimeService.KEY_PAYLOAD, payload);
        response.setData(data);
        send(service, response);
    }

    private static void send(Messenger service, Message message) {
        try {
            service.send(message);
        } catch (Exception error) {
            throw new AssertionError("fixture protocol send failed", error);
        }
    }
}
