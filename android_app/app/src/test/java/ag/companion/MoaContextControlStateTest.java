package ag.companion;

import org.json.JSONObject;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public final class MoaContextControlStateTest {
    @Test
    public void togglesAndArmsPresentationState() {
        MoaContextControlState state = new MoaContextControlState();
        assertFalse(state.isNewThreadArmed());
        assertFalse(state.isIncognitoEnabled());

        assertTrue(state.toggleNewThread());
        assertTrue(state.isNewThreadArmed());
        assertFalse(state.toggleNewThread());
        assertFalse(state.isNewThreadArmed());

        state.armNewThread();
        assertTrue(state.isNewThreadArmed());
        assertTrue(state.toggleIncognito());
        assertTrue(state.isIncognitoEnabled());
        assertFalse(state.toggleIncognito());
        assertFalse(state.isIncognitoEnabled());
    }

    @Test
    public void httpDefaultAddsNoOverride() throws Exception {
        MoaContextControlState state = new MoaContextControlState();
        JSONObject body = new JSONObject().put("text", "hello");

        assertFalse(state.applyTo(body));
        assertFalse(body.has("context_action"));
        assertEquals("hello", body.optString("text"));
    }

    @Test
    public void httpNewThreadIsOneShot() throws Exception {
        MoaContextControlState state = new MoaContextControlState();
        state.armNewThread();

        JSONObject first = new JSONObject();
        assertTrue(state.applyTo(first));
        assertEquals("new", first.optString("context_action"));
        assertFalse(state.isNewThreadArmed());

        JSONObject second = new JSONObject();
        assertFalse(state.applyTo(second));
        assertFalse(second.has("context_action"));
    }

    @Test
    public void consumedHttpBoundaryForbidsFallbackOntoTheOldThread() throws Exception {
        MoaContextControlState state = new MoaContextControlState();
        state.armNewThread();
        JSONObject attempted = new JSONObject();
        assertTrue(state.applyTo(attempted));
        assertTrue(MoaContextControlState.requiresExactBoundary(attempted));
        assertFalse(MoaContextControlState.requiresExactBoundary(new JSONObject()));
        assertFalse(MoaContextControlState.requiresExactBoundary(null));
    }

    @Test
    public void httpIncognitoWinsWithoutConsumingArmedNewThread() throws Exception {
        MoaContextControlState state = new MoaContextControlState();
        state.armNewThread();
        state.toggleIncognito();

        JSONObject incognito = new JSONObject();
        assertFalse(state.applyTo(incognito));
        assertEquals("incognito", incognito.optString("context_action"));
        assertTrue(state.isNewThreadArmed());
        assertTrue(state.isIncognitoEnabled());

        state.toggleIncognito();
        JSONObject next = new JSONObject();
        assertTrue(state.applyTo(next));
        assertEquals("new", next.optString("context_action"));
        assertFalse(state.isNewThreadArmed());
    }

    @Test
    public void streamingDefaultNeedsNoBranchSwitch() {
        MoaContextControlState.StreamingChoice choice =
                new MoaContextControlState().consumeStreamingChoice();

        assertEquals("", choice.action);
        assertFalse(choice.incognito);
        assertFalse(choice.consumedNewThread);
        assertFalse(choice.requiresBranchSwitch());
    }

    @Test
    public void streamingNewThreadIsConsumedOnce() {
        MoaContextControlState state = new MoaContextControlState();
        state.armNewThread();

        MoaContextControlState.StreamingChoice first = state.consumeStreamingChoice();
        assertEquals("new", first.action);
        assertFalse(first.incognito);
        assertTrue(first.consumedNewThread);
        assertTrue(first.requiresBranchSwitch());
        assertFalse(state.isNewThreadArmed());

        assertFalse(state.consumeStreamingChoice().requiresBranchSwitch());
    }

    @Test
    public void streamingIncognitoIsPersistentAndPreservesNewThreadArm() {
        MoaContextControlState state = new MoaContextControlState();
        state.armNewThread();
        state.toggleIncognito();

        MoaContextControlState.StreamingChoice first = state.consumeStreamingChoice();
        MoaContextControlState.StreamingChoice second = state.consumeStreamingChoice();
        assertEquals("incognito", first.action);
        assertTrue(first.incognito);
        assertFalse(first.consumedNewThread);
        assertTrue(first.requiresBranchSwitch());
        assertEquals("incognito", second.action);
        assertTrue(state.isNewThreadArmed());

        state.toggleIncognito();
        assertEquals("new", state.consumeStreamingChoice().action);
    }

    @Test
    public void notSavedMarkerIsBoundedTrimmedAndIdempotent() {
        assertEquals("", MoaContextControlState.appendNotSaved(null));
        assertEquals("", MoaContextControlState.appendNotSaved("   "));
        assertEquals(
                "reply\n\n(not saved)",
                MoaContextControlState.appendNotSaved("  reply  ")
        );
        assertEquals(
                "reply\n\n(not saved)",
                MoaContextControlState.appendNotSaved("reply\n\n(not saved)")
        );
    }
}
