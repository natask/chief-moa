package ag.companion;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public final class MoaPresentationStyleTest {
    @Test
    public void persistedValuesAreMigrationSafe() {
        assertEquals(MoaPresentationStyle.COMPANION, MoaPresentationStyle.fromPersisted(null));
        assertEquals(MoaPresentationStyle.COMPANION, MoaPresentationStyle.fromPersisted("unknown"));
        assertEquals(MoaPresentationStyle.COMPANION, MoaPresentationStyle.fromPersisted("companion"));
        assertEquals(MoaPresentationStyle.MINIMAL, MoaPresentationStyle.fromPersisted(" minimal "));
    }
}
