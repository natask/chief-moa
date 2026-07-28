package ai.moa.assistant;

import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public final class MoaControlCenterCommandTest {
    @Test
    public void recognizesOnlyExplicitControlCenterRequests() {
        assertTrue(MoaControlCenterCommand.isExplicitRequest("/settings"));
        assertTrue(MoaControlCenterCommand.isExplicitRequest("show me the app UI"));
        assertTrue(MoaControlCenterCommand.isExplicitRequest("open Aggie settings"));
        assertTrue(MoaControlCenterCommand.isExplicitRequest("show the control center for Moa"));

        assertFalse(MoaControlCenterCommand.isExplicitRequest("change a setting"));
        assertFalse(MoaControlCenterCommand.isExplicitRequest("open Maps"));
        assertFalse(MoaControlCenterCommand.isExplicitRequest("show me my app"));
    }
}
