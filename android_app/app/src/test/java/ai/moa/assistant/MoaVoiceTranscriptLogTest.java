package ai.moa.assistant;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public final class MoaVoiceTranscriptLogTest {

    @Test
    public void eachTurnAppendsUserAndAssistantRowsInOrder() {
        MoaVoiceTranscriptLog log = new MoaVoiceTranscriptLog(20);

        log.setUser("hello", true);
        log.setAssistant("hi there");
        log.startTurn();
        log.setUser("second", true);
        log.setAssistant("second reply");

        assertEquals(4, log.size());
        assertEquals("hello", log.get(0).text);
        assertTrue(log.get(0).isUser());
        assertEquals("hi there", log.get(1).text);
        assertFalse(log.get(1).isUser());
        assertEquals("second", log.get(2).text);
        assertEquals("second reply", log.get(3).text);
    }

    @Test
    public void partialsUpdateTheCurrentRowInPlaceUntilNextTurn() {
        MoaVoiceTranscriptLog log = new MoaVoiceTranscriptLog(20);

        log.setUser("he", false);
        log.setUser("hello wor", false);
        log.setUser("hello world", true);

        assertEquals(1, log.size());
        assertEquals("hello world", log.get(0).text);
        assertTrue(log.get(0).finalText);
        assertEquals("hello world", log.currentUserText());
    }

    @Test
    public void trimDropsOldestSilentlyAtTheCap() {
        MoaVoiceTranscriptLog log = new MoaVoiceTranscriptLog(3);

        log.setUser("a", true);
        log.startTurn();
        log.setUser("b", true);
        log.startTurn();
        log.setUser("c", true);
        log.startTurn();
        log.setUser("d", true);

        assertEquals(3, log.size());
        assertEquals("b", log.get(0).text);
        assertEquals("c", log.get(1).text);
        assertEquals("d", log.get(2).text);
    }

    @Test
    public void cascadeDismissRemovesTargetAndEveryOlderRow() {
        MoaVoiceTranscriptLog log = new MoaVoiceTranscriptLog(20);
        log.setUser("q1", true);       // index 0
        log.setAssistant("a1");        // index 1
        log.startTurn();
        log.setUser("q2", true);       // index 2
        log.setAssistant("a2");        // index 3
        log.startTurn();
        log.setUser("q3", true);       // index 4

        // Swiping the assistant reply of the 2nd turn (index 3) drops it plus
        // everything above it (indices 0..3), leaving only the newest row.
        int removed = log.dismissCascade(3);

        assertEquals(4, removed);
        assertEquals(1, log.size());
        assertEquals("q3", log.get(0).text);
    }

    @Test
    public void cascadeFromEntryEmptiesLogWhenNewestRowSwiped() {
        MoaVoiceTranscriptLog log = new MoaVoiceTranscriptLog(20);
        log.setUser("q1", true);
        log.setAssistant("a1");
        MoaVoiceTranscriptLog.Entry newest = log.setAssistant("a1"); // same row updated
        log.startTurn();
        MoaVoiceTranscriptLog.Entry last = log.setUser("q2", true);

        int removed = log.dismissCascadeFrom(last);

        // q2 is the newest and everything older cascades with it.
        assertEquals(3, removed);
        assertTrue(log.isEmpty());
        // The captured 'newest' pointer is unrelated to emptiness; assert cleared.
        assertEquals(-1, log.indexOf(newest));
    }

    @Test
    public void startTurnKeepsHistoryButDetachesLivePointers() {
        MoaVoiceTranscriptLog log = new MoaVoiceTranscriptLog(20);
        log.setUser("q1", true);
        log.setAssistant("a1");
        log.startTurn();

        // After a turn boundary, currentUser/currentAssistant are detached, so
        // the next set* appends fresh rows rather than editing the prior turn.
        assertEquals("", log.currentUserText());
        assertEquals("", log.currentAssistantText());
        log.setAssistant("a2");
        assertEquals(3, log.size());
        assertEquals("a1", log.get(1).text);
        assertEquals("a2", log.get(2).text);
    }

    @Test
    public void steeringMarksCurrentReplyAndCollapsesResolvedRows() {
        MoaVoiceTranscriptLog log = new MoaVoiceTranscriptLog(20);
        log.setUser("resolved question", true);
        log.setAssistant("resolved answer");
        log.startTurn();
        log.setUser("current question", true);
        MoaVoiceTranscriptLog.Entry interrupted = log.setAssistant("partial answer");

        assertTrue(log.markSteeringBoundary());

        assertEquals(2, log.size());
        assertEquals("current question", log.get(0).text);
        assertEquals("partial answer", log.get(1).text);
        assertTrue(interrupted.interrupted);
    }
}
