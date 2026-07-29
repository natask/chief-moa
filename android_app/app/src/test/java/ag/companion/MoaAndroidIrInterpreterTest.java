package ag.companion;

import org.json.JSONObject;
import org.junit.Test;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

public final class MoaAndroidIrInterpreterTest {
    @Test
    public void executesBranchLoopWaitCheckpointAndVariableArguments() throws Exception {
        FakeHost host = new FakeHost();
        JSONObject json = new JSONObject("{\"version\":\"moa_android_ir_v1\",\"steps\":["
                + "{\"op\":\"set\",\"name\":\"enabled\",\"value\":true},"
                + "{\"op\":\"if\",\"condition\":{\"var\":\"enabled\"},\"then\":["
                + "{\"op\":\"repeat\",\"times\":2,\"steps\":[{\"op\":\"call\",\"capability\":\"screen.read\",\"arguments\":{\"mode\":\"brief\"},\"assign\":\"last\"}]},"
                + "{\"op\":\"wait\",\"millis\":25},{\"op\":\"checkpoint\",\"name\":\"screen-read\"}],\"else\":[]},"
                + "{\"op\":\"return\",\"value\":{\"var\":\"last\"}}]}");

        MoaAndroidIrInterpreter.Result result = interpreter(host, 50, 1000, 1000, false).execute(MoaAndroidIrProgram.parse(json));

        assertEquals("result-2", result.value);
        assertEquals(Arrays.asList("screen.read:brief", "screen.read:brief"), host.calls);
        assertEquals(Collections.singletonList("screen-read"), host.checkpoints);
        assertEquals(25, host.now);
    }

    @Test
    public void recoversFromHostFailure() throws Exception {
        FakeHost host = new FakeHost();
        host.failCalls = true;
        JSONObject json = program("{\"op\":\"try\",\"steps\":[{\"op\":\"call\",\"capability\":\"screen.read\"}],"
                + "\"recover\":[{\"op\":\"return\",\"value\":\"recovered\"}]}");
        assertEquals("recovered", interpreter(host, 10, 100, 1000, false)
                .execute(MoaAndroidIrProgram.parse(json)).value);
    }

    @Test
    public void enforcesCapabilityAllowlist() throws Exception {
        FakeHost host = new FakeHost();
        JSONObject json = program("{\"op\":\"call\",\"capability\":\"shell.exec\"}");
        assertFailure(interpreter(host, 10, 100, 1000, false), json, "capability is not allowed");
        assertTrue(host.calls.isEmpty());
    }

    @Test
    public void enforcesStepWallDataAndCancellationBudgets() throws Exception {
        JSONObject loop = program("{\"op\":\"repeat\",\"times\":3,\"steps\":[{\"op\":\"checkpoint\",\"name\":\"x\"}]}");
        assertFailure(interpreter(new FakeHost(), 2, 100, 1000, false), loop, "step budget exceeded");

        JSONObject wait = program("{\"op\":\"wait\",\"millis\":101}");
        assertFailure(interpreter(new FakeHost(), 10, 100, 1000, false), wait, "wall-time budget exceeded");

        JSONObject data = program("{\"op\":\"set\",\"name\":\"large\",\"value\":\"abcdefghijklmnopqrstuvwxyz\"}");
        assertFailure(interpreter(new FakeHost(), 10, 100, 10, false), data, "data budget exceeded");

        assertFailure(interpreter(new FakeHost(), 10, 100, 1000, true), program("{\"op\":\"checkpoint\",\"name\":\"x\"}"), "cancelled");
    }

    @Test
    public void rejectsUnknownUnboundedAndMalformedProgramsBeforeExecution() throws Exception {
        assertInvalid(program("{\"op\":\"javascript\",\"source\":\"while(true){}\"}"), "unknown op");
        assertInvalid(program("{\"op\":\"repeat\",\"steps\":[]}"), "times must be an integer");
        assertInvalid(program("{\"op\":\"repeat\",\"times\":101,\"steps\":[]}"), "repeat must be between");
        assertInvalid(program("{\"op\":\"call\",\"capability\":\"screen.read\",\"className\":\"java.lang.Runtime\"}"), "unknown field");
    }

    private static JSONObject program(String step) throws Exception {
        return new JSONObject("{\"version\":\"moa_android_ir_v1\",\"steps\":[" + step + "]}");
    }

    private static MoaAndroidIrInterpreter interpreter(FakeHost host, int steps, long wall, int data, boolean cancelled) {
        return new MoaAndroidIrInterpreter(host, new HashSet<>(Collections.singletonList("screen.read")),
                new MoaAndroidIrInterpreter.Limits(steps, wall, data), () -> cancelled);
    }

    private static void assertFailure(MoaAndroidIrInterpreter interpreter, JSONObject json, String expected) throws Exception {
        try {
            interpreter.execute(MoaAndroidIrProgram.parse(json));
            fail("expected execution failure");
        } catch (MoaAndroidIrInterpreter.ExecutionException failure) {
            assertTrue(failure.getMessage(), failure.getMessage().contains(expected));
        }
    }

    private static void assertInvalid(JSONObject json, String expected) {
        try {
            MoaAndroidIrProgram.parse(json);
            fail("expected validation failure");
        } catch (IllegalArgumentException failure) {
            assertTrue(failure.getMessage(), failure.getMessage().contains(expected));
        }
    }

    private static final class FakeHost implements MoaAndroidIrHost {
        final List<String> calls = new ArrayList<>();
        final List<String> checkpoints = new ArrayList<>();
        long now;
        boolean failCalls;

        @Override public Object call(String capability, JSONObject arguments) throws Exception {
            if (failCalls) throw new Exception("fake failure");
            calls.add(capability + ":" + arguments.optString("mode"));
            return "result-" + calls.size();
        }

        @Override public void waitMillis(long millis) { now += millis; }
        @Override public void checkpoint(String name) { checkpoints.add(name); }
        @Override public long monotonicTimeMillis() { return now; }
    }
}
