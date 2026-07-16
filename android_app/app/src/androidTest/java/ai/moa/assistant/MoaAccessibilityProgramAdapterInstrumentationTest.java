package ai.moa.assistant;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.app.Activity;
import android.content.Intent;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.util.Collections;
import java.util.Set;
import java.util.concurrent.TimeUnit;

/** Synthetic-only proof for live Accessibility observation, action, and stale-state binding. */
@RunWith(AndroidJUnit4.class)
public final class MoaAccessibilityProgramAdapterInstrumentationTest {
    @Test
    public void syntheticFixtureRedactsAndBindsClickScrollAndStaleState() throws Exception {
        Intent intent = new Intent(
                InstrumentationRegistry.getInstrumentation().getTargetContext(),
                MoaAccessibilityFixtureActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        Activity activity = InstrumentationRegistry.getInstrumentation().startActivitySync(intent);
        try {
            BoundState state = awaitBoundState(null, null);
            JSONObject observation = state.observation;
            assertFalse("password fixture escaped redaction",
                    observation.toString().contains(MoaAccessibilityFixtureActivity.PRIVATE_FIXTURE_VALUE));
            assertEquals("ai.moa.assistant", observation.getString("expected_package"));

            MoaSurfaceProgramContract.Proposal proposal = proposal(state.binding);
            JSONObject actionNode = find(observation, "synthetic action button");
            int beforeClick = MoaAccessibilityFixtureActivity.CLICK_COUNT.get();
            MoaAccessibilityProgramAdapter.ProgramActionResult click =
                    MoaAccessibilityProgramAdapter.execute(
                            proposal,
                            MoaScriptExecutionCatalog.CLICK,
                            nodeInput(observation, actionNode));
            assertEquals("indeterminate", click.status);
            awaitClick(beforeClick + 1);

            state = awaitBoundState(observation.getString("observation_digest"), null);
            observation = state.observation;
            proposal = proposal(state.binding);
            JSONObject scrollNode = find(observation, "synthetic scrolling region");
            int beforeScroll = MoaAccessibilityFixtureActivity.SCROLL_Y.get();
            MoaAccessibilityProgramAdapter.ProgramActionResult scroll =
                    MoaAccessibilityProgramAdapter.execute(
                            proposal,
                            MoaScriptExecutionCatalog.SCROLL,
                            nodeInput(observation, scrollNode).put("direction", "forward"));
            assertEquals("indeterminate", scroll.status);
            awaitScrollBeyond(beforeScroll);

            state = awaitBoundState(observation.getString("observation_digest"), null);
            observation = state.observation;
            proposal = proposal(state.binding);
            actionNode = find(observation, "synthetic action button");
            JSONObject staleInput = nodeInput(observation, actionNode);
            InstrumentationRegistry.getInstrumentation().runOnMainSync(
                    ((MoaAccessibilityFixtureActivity) activity)::introduceSemanticDrift);
            awaitBoundState(
                    observation.getString("observation_digest"),
                    "Synthetic drift marker");
            int beforeStaleClick = MoaAccessibilityFixtureActivity.CLICK_COUNT.get();
            assertEquals("stale_state", MoaAccessibilityProgramAdapter.execute(
                    proposal, MoaScriptExecutionCatalog.CLICK, staleInput).status);
            assertEquals(beforeStaleClick, MoaAccessibilityFixtureActivity.CLICK_COUNT.get());
        } finally {
            activity.finish();
        }
    }

    private static BoundState awaitBoundState(String previousDigest, String requiredLabel)
            throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        do {
            JSONObject observation = MoaAccessibilityProgramAdapter.currentObservation();
            JSONObject binding = MoaAccessibilityProgramAdapter.currentBinding();
            if (observation != null
                    && binding != null
                    && MoaAccessibilityFixtureActivity.MARKER.equals(
                    findLabel(observation, MoaAccessibilityFixtureActivity.MARKER))
                    && (requiredLabel == null || requiredLabel.equals(findLabel(observation, requiredLabel)))
                    && (previousDigest == null
                    || !previousDigest.equals(observation.optString("observation_digest")))
                    && bindingMatches(observation, binding)) {
                return new BoundState(observation, binding);
            }
            Thread.sleep(100L);
        } while (System.nanoTime() < deadline);
        throw new AssertionError(
                "coherent synthetic fixture state was not observed; enable MoaAccessibilityService on the dedicated emulator");
    }

    private static void awaitClick(int expected) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (System.nanoTime() < deadline) {
            if (MoaAccessibilityFixtureActivity.CLICK_COUNT.get() == expected) return;
            Thread.sleep(50L);
        }
        throw new AssertionError("synthetic Accessibility click did not reach the fixture");
    }

    private static void awaitScrollBeyond(int previous) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (System.nanoTime() < deadline) {
            if (MoaAccessibilityFixtureActivity.SCROLL_Y.get() > previous) return;
            Thread.sleep(50L);
        }
        throw new AssertionError("synthetic Accessibility scroll did not move the fixture");
    }

    private static JSONObject find(JSONObject observation, String query) throws Exception {
        JSONObject result = MoaAccessibilityProgramAdapter.find(new JSONObject()
                .put("observation_id", observation.getString("observation_id"))
                .put("observation_digest", observation.getString("observation_digest"))
                .put("query", query));
        assertNotNull(result);
        JSONArray nodes = result.getJSONArray("nodes");
        assertEquals(1, nodes.length());
        return nodes.getJSONObject(0);
    }

    private static String findLabel(JSONObject observation, String expected) throws Exception {
        JSONArray nodes = observation.getJSONArray("nodes");
        for (int index = 0; index < nodes.length(); index++) {
            String label = nodes.getJSONObject(index).optString("label", "");
            if (expected.equals(label)) return label;
        }
        return "";
    }

    private static boolean bindingMatches(JSONObject observation, JSONObject binding)
            throws Exception {
        return observation.getString("expected_package").equals(binding.getString("package_name"))
                && observation.getString("window_id").equals(binding.getString("window_id"))
                && observation.getString("observation_id").equals(binding.getString("observation_id"))
                && observation.getLong("window_generation")
                == binding.getLong("observation_generation")
                && observation.getString("observation_digest")
                .equals(binding.getString("state_sha256"));
    }

    private static JSONObject nodeInput(JSONObject observation, JSONObject node) throws Exception {
        return new JSONObject()
                .put("observation_id", observation.getString("observation_id"))
                .put("observation_digest", observation.getString("observation_digest"))
                .put("node_id", node.getString("node_id"));
    }

    private static MoaSurfaceProgramContract.Proposal proposal(JSONObject binding) throws Exception {
        JSONObject copy = new JSONObject(binding.toString());
        return new MoaSurfaceProgramContract.Proposal(
                "fixture_execution",
                "fixture_session",
                "fixture_turn",
                "fixture_device",
                "async function main(){}",
                "0".repeat(64),
                MoaScriptExecutionCatalog.sha256(),
                Set.of(MoaScriptExecutionCatalog.CLICK, MoaScriptExecutionCatalog.SCROLL),
                copy,
                MoaProgramJson.sha256(MoaProgramJson.canonical(copy)),
                copy.getString("package_name"),
                copy.getString("window_id"),
                copy.getString("observation_id"),
                copy.getLong("observation_generation"),
                copy.getString("state_sha256"),
                new MoaSurfaceProgramContract.Limits(1024, 10_000, 4, 1, 1024, 0),
                "preauthorized",
                Collections.emptySet(),
                "fixture_idempotency",
                0L,
                Long.MAX_VALUE,
                "1".repeat(64));
    }

    private static final class BoundState {
        final JSONObject observation;
        final JSONObject binding;

        BoundState(JSONObject observation, JSONObject binding) {
            this.observation = observation;
            this.binding = binding;
        }
    }
}
