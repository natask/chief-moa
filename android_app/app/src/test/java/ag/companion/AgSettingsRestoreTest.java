package ag.companion;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public class AgSettingsRestoreTest {

    private static JSONObject payload(int schemaVersion, JSONObject settings) {
        try {
            return new JSONObject()
                    .put("schema_version", 1)
                    .put("settings_schema_version", schemaVersion)
                    .put("account_id", "owner_1")
                    .put("local_state_transferred", false)
                    .put("settings", settings);
        } catch (Exception error) {
            throw new AssertionError(error);
        }
    }

    private static JSONObject json(String... pairs) {
        JSONObject result = new JSONObject();
        try {
            for (int i = 0; i + 1 < pairs.length; i += 2) {
                result.put(pairs[i], pairs[i + 1]);
            }
        } catch (Exception error) {
            throw new AssertionError(error);
        }
        return result;
    }

    @Test
    public void freshInstallRestoresAccountSettingsWithNoLocalState() throws Exception {
        AgSettingsRestore.Result result = AgSettingsRestore.apply("",
                payload(AgSettingsRestore.CLIENT_SCHEMA_VERSION,
                        json("assistant_name", "Ag", "voice", "Aoede", "user_address", "master")));

        assertEquals(AgSettingsRestore.Status.RESTORED, result.status);
        JSONObject restored = new JSONObject(result.settingsJson);
        assertEquals("Ag", restored.getString("assistant_name"));
        assertEquals("Aoede", restored.getString("voice"));
        assertEquals("master", restored.getString("user_address"));
        assertTrue(result.appliedFields.contains("voice"));
        assertEquals("", result.note);
    }

    @Test
    public void restoreNeverBlanksOrDropsAStoredSetting() throws Exception {
        AgSettingsRestore.Result result = AgSettingsRestore.apply(
                json("voice", "Kore", "speaking_rate", "1.5", "language", "am-ET").toString(),
                payload(AgSettingsRestore.CLIENT_SCHEMA_VERSION, json("voice", "Aoede", "language", "  ")));

        JSONObject restored = new JSONObject(result.settingsJson);
        assertEquals("Aoede", restored.getString("voice"));
        assertEquals("am-ET", restored.getString("language"));
        assertEquals("1.5", restored.getString("speaking_rate"));
    }

    @Test
    public void anOlderServerSchemaIsUpgradedByMigrationsShippedWithTheRelease() throws Exception {
        Map<String, String> renames = new LinkedHashMap<>();
        renames.put("legacy_voice", "voice");
        List<AgSettingsRestore.Migration> steps = Arrays.asList(
                new AgSettingsRestore.Migration(2, renames),
                new AgSettingsRestore.Migration(3, Map.of("nickname", "user_nickname")));

        JSONObject upgraded = AgSettingsRestore.migrate(
                json("legacy_voice", "Kore", "nickname", "Nat"), 1, 3, steps);

        assertEquals("Kore", upgraded.getString("voice"));
        assertEquals("Nat", upgraded.getString("user_nickname"));
        assertFalse(upgraded.has("legacy_voice"));
        assertFalse(upgraded.has("nickname"));
    }

    @Test
    public void migrationsAlreadySeenOrNotYetShippedAreSkipped() throws Exception {
        List<AgSettingsRestore.Migration> steps = Arrays.asList(
                new AgSettingsRestore.Migration(2, Map.of("legacy_voice", "voice")),
                new AgSettingsRestore.Migration(4, Map.of("voice", "future_voice")));

        JSONObject atServerVersionTwo = AgSettingsRestore.migrate(json("legacy_voice", "Kore"), 2, 3, steps);
        assertEquals("Kore", atServerVersionTwo.getString("legacy_voice"));
        assertFalse(atServerVersionTwo.has("voice"));

        JSONObject beyondThisBuild = AgSettingsRestore.migrate(json("voice", "Kore"), 1, 3, steps);
        assertEquals("Kore", beyondThisBuild.getString("voice"));
        assertFalse(beyondThisBuild.has("future_voice"));
    }

    @Test
    public void aNewerServerSchemaIsKeptAndReportedRatherThanDiscarded() throws Exception {
        AgSettingsRestore.Result result = AgSettingsRestore.apply("",
                payload(AgSettingsRestore.CLIENT_SCHEMA_VERSION + 1,
                        json("voice", "Aoede", "field_from_the_future", "keep me")));

        assertEquals(AgSettingsRestore.Status.RESTORED_PARTIAL, result.status);
        assertTrue(result.restored());
        JSONObject restored = new JSONObject(result.settingsJson);
        assertEquals("Aoede", restored.getString("voice"));
        assertEquals("keep me", restored.getString("field_from_the_future"));
        assertTrue(result.note.contains("update Ag"));
    }

    @Test
    public void anUnverifiableSnapshotLeavesStoredSettingsUntouched() throws Exception {
        String stored = json("voice", "Kore").toString();

        for (JSONObject bad : List.of(
                payload(AgSettingsRestore.CLIENT_SCHEMA_VERSION, json("voice", "Aoede"))
                        .put("local_state_transferred", true),
                payload(0, json("voice", "Aoede")),
                new JSONObject().put("schema_version", 1).put("settings_schema_version", 1)
                        .put("local_state_transferred", false))) {
            AgSettingsRestore.Result result = AgSettingsRestore.apply(stored, bad);
            assertEquals(AgSettingsRestore.Status.REJECTED, result.status);
            assertFalse(result.restored());
            assertEquals("Kore", new JSONObject(result.settingsJson).getString("voice"));
            assertTrue(result.appliedFields.isEmpty());
        }

        AgSettingsRestore.Result missing = AgSettingsRestore.apply(stored, null);
        assertEquals(AgSettingsRestore.Status.REJECTED, missing.status);
        assertEquals("Kore", new JSONObject(missing.settingsJson).getString("voice"));
    }

    @Test
    public void corruptStoredSettingsDoNotBlockARestore() throws Exception {
        AgSettingsRestore.Result result = AgSettingsRestore.apply("{not json",
                payload(AgSettingsRestore.CLIENT_SCHEMA_VERSION, json("voice", "Aoede")));

        assertEquals(AgSettingsRestore.Status.RESTORED, result.status);
        assertEquals("Aoede", new JSONObject(result.settingsJson).getString("voice"));
    }
}
