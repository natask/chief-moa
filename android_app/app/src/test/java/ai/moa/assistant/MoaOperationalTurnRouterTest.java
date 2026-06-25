package ai.moa.assistant;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public final class MoaOperationalTurnRouterTest {
    @Test
    public void normalizesSpeechForRoutingPhrases() {
        assertEquals("what s going on", MoaOperationalTurnRouter.normalizeSpeech("What's going on?"));
        assertEquals("chrome extension android app", MoaOperationalTurnRouter.normalizeSpeech("Chrome extension, Android app."));
    }

    @Test
    public void extractsExplicitAgentPrompts() {
        assertEquals("ship it", MoaOperationalTurnRouter.agentPromptFrom("/agent ship it"));
        assertEquals("run tests", MoaOperationalTurnRouter.agentPromptFrom("moa run run tests"));
        assertEquals("", MoaOperationalTurnRouter.agentPromptFrom("just chat"));
    }

    @Test
    public void routesOperationalSystemQuestionsThroughMoa() {
        assertTrue(MoaOperationalTurnRouter.shouldRouteThroughMoa("what is going on?"));
        assertTrue(MoaOperationalTurnRouter.shouldRouteThroughMoa("what's going on with the operational systems?"));
        assertTrue(MoaOperationalTurnRouter.shouldRouteThroughMoa("look at the Chrome extension, Android app, and mobile gateway"));
        assertTrue(MoaOperationalTurnRouter.shouldRouteThroughMoa("we need forward progress on all the projects"));
        assertFalse(MoaOperationalTurnRouter.shouldRouteThroughMoa("what is the weather today?"));
    }

    @Test
    public void routesProfileControlThroughMoaWithoutForcingAgent() {
        assertTrue(MoaOperationalTurnRouter.isProfileControlIntent("use the Kore voice"));
        assertTrue(MoaOperationalTurnRouter.isProfileControlIntent("switch to a female voice"));
        assertTrue(MoaOperationalTurnRouter.isProfileControlIntent("switch to Aoede"));
        assertTrue(MoaOperationalTurnRouter.isProfileControlIntent("change voices"));
        assertTrue(MoaOperationalTurnRouter.isProfileControlIntent("go through all the voices and say hello in every voice"));
        assertTrue(MoaOperationalTurnRouter.isProfileControlIntent("sample the voices for me one after the other"));
        assertTrue(MoaOperationalTurnRouter.isProfileControlIntent("only speak English and Amharic, don't switch up"));
        assertTrue(MoaOperationalTurnRouter.isProfileControlIntent("respond only in English"));
        assertTrue(MoaOperationalTurnRouter.isProfileControlIntent("speak Amharic and English"));
        assertTrue(MoaOperationalTurnRouter.isProfileControlIntent("only process English and Amharic"));
        assertTrue(MoaOperationalTurnRouter.isProfileControlIntent("change your language to Amharic"));
        assertTrue(MoaOperationalTurnRouter.isProfileControlIntent("what voice is active"));
        assertTrue(MoaOperationalTurnRouter.isProfileControlIntent("what language settings are active"));
        assertTrue(MoaOperationalTurnRouter.isProfileControlIntent("set your system prompt to be terser"));
        assertTrue(MoaOperationalTurnRouter.shouldRouteThroughMoa("use the Kore voice"));
        assertTrue(MoaOperationalTurnRouter.shouldRouteThroughMoa("go through all the voices"));
        assertTrue(MoaOperationalTurnRouter.shouldRouteThroughMoa("only process English and Amharic"));
        assertTrue(MoaOperationalTurnRouter.shouldRouteThroughMoa("only speak English and Amharic, don't switch up"));
        assertFalse(MoaOperationalTurnRouter.shouldForceAgent("use the Kore voice"));
        assertFalse(MoaOperationalTurnRouter.shouldForceAgent("change voices"));
        assertFalse(MoaOperationalTurnRouter.shouldForceAgent("go through all the voices"));
        assertFalse(MoaOperationalTurnRouter.shouldForceAgent("only process English and Amharic"));
        assertFalse(MoaOperationalTurnRouter.shouldForceAgent("only speak English and Amharic, don't switch up"));
    }

    @Test
    public void forcesAgentForOperationalSystemQuestions() {
        assertTrue(MoaOperationalTurnRouter.shouldForceAgent("what is going on?"));
        assertTrue(MoaOperationalTurnRouter.shouldForceAgent("mobile gateway status"));
        assertTrue(MoaOperationalTurnRouter.shouldForceAgent("what am I working on?"));
        assertFalse(MoaOperationalTurnRouter.shouldForceAgent("what is the weather today?"));
    }

    @Test
    public void voiceOnlyActionStartsStillRequireVoiceContext() {
        assertTrue(MoaOperationalTurnRouter.shouldRunAgentFromVoice("fix the gateway", true));
        assertFalse(MoaOperationalTurnRouter.shouldRunAgentFromVoice("fix the gateway", false));
    }
}
