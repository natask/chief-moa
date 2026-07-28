package ai.moa.assistant;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import java.util.Arrays;

import org.junit.Test;

public final class MoaTranscriptVariantsTest {

    @Test
    public void theLiteralTranscriptIsTheFloor() {
        MoaTranscriptVariants variants = new MoaTranscriptVariants();
        variants.setLiteral("um how much is the the flight to addis");

        assertSame(MoaTranscriptVariants.Variant.LITERAL, variants.defaultVariant());
        assertEquals("um how much is the the flight to addis", variants.defaultText());
        assertEquals(Arrays.asList(MoaTranscriptVariants.Variant.LITERAL), variants.available());
    }

    @Test
    public void thePolishedVariantIsTheDefaultCopyWhenItExists() {
        MoaTranscriptVariants variants = new MoaTranscriptVariants();
        variants.setLiteral("um how much is the the flight to addis");
        variants.setCorrected("How much is the flight to Addis?");
        variants.setPolished("What does a flight to Addis run these days?");

        assertSame(MoaTranscriptVariants.Variant.POLISHED, variants.defaultVariant());
        assertEquals("What does a flight to Addis run these days?", variants.defaultText());
    }

    @Test
    public void correctedIsTheDefaultWhenNothingIsPolishedYet() {
        MoaTranscriptVariants variants = new MoaTranscriptVariants();
        variants.setLiteral("um how much is the the flight to addis");
        variants.setCorrected("How much is the flight to Addis?");

        assertSame(MoaTranscriptVariants.Variant.CORRECTED, variants.defaultVariant());
    }

    @Test
    public void aDerivedVariantNeverOverwritesTheLiteralTranscript() {
        MoaTranscriptVariants variants = new MoaTranscriptVariants();
        variants.setLiteral("um how much is the the flight to addis");
        variants.setPolished("What does a flight to Addis run these days?");

        // The spec's contract: applying a writing skill leaves the literal
        // transcript byte-for-byte unchanged and still selectable.
        assertEquals("um how much is the the flight to addis",
                variants.text(MoaTranscriptVariants.Variant.LITERAL));
    }

    @Test
    public void missingVariantsAreReportedAbsentRatherThanFabricated() {
        MoaTranscriptVariants variants = new MoaTranscriptVariants();
        variants.setLiteral("something");

        assertTrue(variants.has(MoaTranscriptVariants.Variant.LITERAL));
        assertFalse(variants.has(MoaTranscriptVariants.Variant.CORRECTED));
        assertFalse(variants.has(MoaTranscriptVariants.Variant.POLISHED));
        assertEquals("", variants.text(MoaTranscriptVariants.Variant.POLISHED));
    }

    @Test
    public void availableIsMostPolishedFirst() {
        MoaTranscriptVariants variants = new MoaTranscriptVariants();
        variants.setLiteral("a");
        variants.setPolished("c");

        assertEquals(
                Arrays.asList(
                        MoaTranscriptVariants.Variant.POLISHED,
                        MoaTranscriptVariants.Variant.LITERAL),
                variants.available());
    }

    @Test
    public void clearingDropsEveryVariant() {
        MoaTranscriptVariants variants = new MoaTranscriptVariants();
        variants.setLiteral("a");
        variants.setCorrected("b");
        variants.setPolished("c");
        variants.clear();

        assertTrue(variants.isEmpty());
        assertTrue(variants.available().isEmpty());
        assertEquals("", variants.defaultText());
    }

    @Test
    public void everyVariantHasItsOwnLabel() {
        assertEquals("Copy polished",
                MoaTranscriptVariants.label(MoaTranscriptVariants.Variant.POLISHED));
        assertEquals("Copy corrected",
                MoaTranscriptVariants.label(MoaTranscriptVariants.Variant.CORRECTED));
        assertEquals("Copy literal",
                MoaTranscriptVariants.label(MoaTranscriptVariants.Variant.LITERAL));
    }
}
