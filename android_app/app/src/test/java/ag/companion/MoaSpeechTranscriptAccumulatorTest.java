package ag.companion;

import org.junit.Test;

import static org.junit.Assert.assertEquals;

public final class MoaSpeechTranscriptAccumulatorTest {
    @Test
    public void cumulativeRecognizerUpdatesReplaceOlderHypothesis() {
        MoaSpeechTranscriptAccumulator accumulator = new MoaSpeechTranscriptAccumulator();

        assertEquals("the first couple sections", accumulator.update("the first couple sections"));
        assertEquals(
                "the first couple sections are not properly sent",
                accumulator.update("the first couple sections are not properly sent")
        );
    }

    @Test
    public void segmentedUpdatesKeepEarlierSpeech() {
        MoaSpeechTranscriptAccumulator accumulator = new MoaSpeechTranscriptAccumulator();

        accumulator.update("the first couple sections are not");

        assertEquals(
                "the first couple sections are not properly sent",
                accumulator.update("not properly sent")
        );
    }

    @Test
    public void finalSuffixDoesNotDropEarlierSpeech() {
        MoaSpeechTranscriptAccumulator accumulator = new MoaSpeechTranscriptAccumulator();

        accumulator.update("the first couple sections are not properly sent only the last couple sections get sent");

        assertEquals(
                "the first couple sections are not properly sent only the last couple sections get sent",
                accumulator.update("only the last couple sections get sent")
        );
    }

    @Test
    public void distinctLaterSegmentAppendsToEarlierSpeech() {
        MoaSpeechTranscriptAccumulator accumulator = new MoaSpeechTranscriptAccumulator();

        accumulator.update("the first couple sections are not properly sent");

        assertEquals(
                "the first couple sections are not properly sent only the last couple sections get sent",
                accumulator.update("only the last couple sections get sent")
        );
    }

    @Test
    public void streamingSegmentsKeepEarlySpeechWhenFinalIsOnlyTail() {
        MoaSpeechTranscriptAccumulator accumulator = new MoaSpeechTranscriptAccumulator();

        assertEquals("for whatever reason when I speak", accumulator.update("for whatever reason when I speak"));
        assertEquals(
                "for whatever reason when I speak what I'm saying doesn't get automatically sent",
                accumulator.update("what I'm saying doesn't get automatically sent")
        );
        assertEquals(
                "for whatever reason when I speak what I'm saying doesn't get automatically sent",
                accumulator.update("doesn't get automatically sent")
        );
    }
}
