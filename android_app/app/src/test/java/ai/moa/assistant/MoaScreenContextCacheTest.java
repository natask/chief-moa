package ai.moa.assistant;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public final class MoaScreenContextCacheTest {
    @Test
    public void serviceUnbindStyleClearRemovesAllStaleSemanticState() {
        MoaScreenContextCache cache = new MoaScreenContextCache();
        cache.update("pkg", "Editor", "secret-adjacent summary", 100L, true);
        assertTrue(cache.read().available());
        assertTrue(cache.read().secureContent);

        cache.clear();

        MoaScreenContextCache.Snapshot cleared = cache.read();
        assertFalse(cleared.available());
        assertEquals("", cleared.packageName);
        assertEquals("", cleared.className);
        assertEquals("", cleared.summary);
        assertEquals(0L, cleared.updatedAtMs);
        assertFalse(cleared.secureContent);
    }

    @Test
    public void nullCacheValuesNormalizeWithoutAuthority() {
        MoaScreenContextCache cache = new MoaScreenContextCache();
        cache.update(null, null, null, -1L, false);
        assertFalse(cache.read().available());
        assertEquals("", cache.read().summary);
        cache.update("pkg", "Editor", "summary", 0L, false);
        assertFalse(cache.read().available());
    }
}
