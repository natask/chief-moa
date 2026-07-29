package ag.companion;

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
        assertEquals("ship it", MoaOperationalTurnRouter.agentPromptFrom("/run ship it"));
        assertEquals("ship it", MoaOperationalTurnRouter.agentPromptFrom("agent run ship it"));
        assertEquals("run tests", MoaOperationalTurnRouter.agentPromptFrom("moa run run tests"));
        assertEquals("", MoaOperationalTurnRouter.agentPromptFrom("just chat"));
        assertEquals("", MoaOperationalTurnRouter.agentPromptFrom(null));
    }

    @Test
    public void routesOperationalSystemQuestionsThroughMoa() {
        assertTrue(MoaOperationalTurnRouter.shouldRouteThroughMoa("what's going on with the operational systems?"));
        assertTrue(MoaOperationalTurnRouter.shouldRouteThroughMoa("look at the Chrome extension, Android app, and mobile gateway"));
        assertTrue(MoaOperationalTurnRouter.shouldRouteThroughMoa("we need forward progress on all the projects"));
        assertFalse(MoaOperationalTurnRouter.shouldRouteThroughMoa("what is going on here on this trading page?"));
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
        assertTrue(MoaOperationalTurnRouter.shouldForceAgent("what is going on with the operational systems?"));
        assertTrue(MoaOperationalTurnRouter.shouldForceAgent("mobile gateway status"));
        assertTrue(MoaOperationalTurnRouter.shouldForceAgent("what am I working on?"));
        assertFalse(MoaOperationalTurnRouter.shouldForceAgent("what is going on here on this trading page?"));
        assertFalse(MoaOperationalTurnRouter.shouldForceAgent("what is the weather today?"));
    }

    @Test
    public void voiceOnlyActionStartsStillRequireVoiceContext() {
        assertTrue(MoaOperationalTurnRouter.shouldRunAgentFromVoice("fix the gateway", true));
        assertFalse(MoaOperationalTurnRouter.shouldRunAgentFromVoice("fix the gateway", false));
    }

    @Test
    public void recognizesEveryVoiceActionPrefixAndEmbeddedActionPhrase() {
        String[] starts = new String[]{
                "make", "build", "fix", "change", "implement", "add", "update", "refactor",
                "test", "create", "wire", "hook up", "continue", "make progress"
        };
        for (String start : starts) {
            assertTrue(start, MoaOperationalTurnRouter.shouldRunAgentFromVoice(start + " the project", true));
        }

        String[] phrases = new String[]{
                "please push code", "please make it work", "please run the tests",
                "check the home machine", "work in the repo", "change this in the app"
        };
        for (String phrase : phrases) {
            assertTrue(phrase, MoaOperationalTurnRouter.shouldRunAgentFromVoice(phrase, true));
        }
        assertFalse(MoaOperationalTurnRouter.shouldRunAgentFromVoice("", true));
        assertFalse(MoaOperationalTurnRouter.shouldRunAgentFromVoice(null, true));
        assertFalse(MoaOperationalTurnRouter.shouldRunAgentFromVoice("make", true));
        assertFalse(MoaOperationalTurnRouter.shouldRunAgentFromVoice("change your language", true));
    }

    @Test
    public void coversProfileIdentityLanguageAndVoiceIntentShapes() {
        String[] directControls = new String[]{
                "what prompt is active", "which prompt do you use", "current prompt please",
                "update system prompt now", "what is your name", "what's your name", "who are you",
                "your name should be Aggie", "call yourself Aggie", "name yourself Aggie",
                "you are now called Aggie", "youre named Aggie",
                "what language is active", "which language is active", "language is active",
                "switch language to English", "what voices exist", "which voices exist",
                "use a voice", "make the voice warmer"
        };
        for (String control : directControls) {
            assertTrue(control, MoaOperationalTurnRouter.isProfileControlIntent(control));
        }

        String[] languageControls = new String[]{
                "talk in English", "reply in Amharic", "answer in English", "say it in Amharic",
                "understand English", "listen for Amharic", "recognize English", "restrict Amharic",
                "select English", "allow Amharic", "English only please", "do not switch from English",
                "dont switch from Amharic", "use English and Amharic as these languages",
                "use English and Amharic as these two languages"
        };
        for (String control : languageControls) {
            assertTrue(control, MoaOperationalTurnRouter.isProfileControlIntent(control));
        }

        String[] voiceControls = new String[]{
                "sound like a woman", "sound like a girl", "sound like someone feminine", "sound like a lady",
                "speak like a male", "speak like a man", "speak like a guy", "speak like someone masculine",
                "speak like a boy", "sound like Fenrir", "set Zephyr", "switch to Puck"
        };
        for (String control : voiceControls) {
            assertTrue(control, MoaOperationalTurnRouter.isProfileControlIntent(control));
        }

        assertFalse(MoaOperationalTurnRouter.isProfileControlIntent(""));
        assertFalse(MoaOperationalTurnRouter.isProfileControlIntent(null));
        assertFalse(MoaOperationalTurnRouter.isProfileControlIntent("English breakfast"));
        assertFalse(MoaOperationalTurnRouter.isProfileControlIntent("sound like a robot"));
        assertFalse(MoaOperationalTurnRouter.isProfileControlIntent("Kore is a place"));
    }

    @Test
    public void recognizesVoiceSamplerGrammarVariants() {
        String[] samplerCommands = new String[]{
                "sample voices", "test voices", "try voices", "preview voices", "demo voices",
                "demonstrate voices", "audition voices", "hear voices", "go through voices",
                "run through voices", "walk through voices", "cycle through voices",
                "say hello in all voices", "speak with every voice", "read with each of the voices",
                "play in all voices", "all voices change now", "voices one after the other",
                "voice one by one", "voices in order", "voices sequentially"
        };
        for (String command : samplerCommands) {
            assertTrue(command, MoaOperationalTurnRouter.isProfileControlIntent(command));
        }
        assertFalse(MoaOperationalTurnRouter.isProfileControlIntent("sample music"));
        assertFalse(MoaOperationalTurnRouter.isProfileControlIntent("all voices are different"));
    }

    @Test
    public void recognizesAllOperationalStatusPhrases() {
        String[] statusQueries = new String[]{
                "operating status", "projects I have ongoing", "all the projects",
                "what am I working on", "forward progress", "chrome extension", "android app",
                "mobile gateway", "moa gateway"
        };
        for (String query : statusQueries) {
            assertTrue(query, MoaOperationalTurnRouter.shouldForceAgent(query));
        }
        assertTrue(MoaOperationalTurnRouter.shouldRouteThroughMoa("what are all the things"));
        assertTrue(MoaOperationalTurnRouter.shouldRouteThroughMoa("/agent inspect status"));
        assertFalse(MoaOperationalTurnRouter.shouldRouteThroughMoa(""));
        assertFalse(MoaOperationalTurnRouter.shouldRouteThroughMoa(null));
    }
}
