package ag.companion;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

public final class MoaActionApprovalControllerTest {
    private static final long CREATED = 1_000L;
    private static final long EXPIRES = 2_000L;

    @Test
    public void canonicalDigestIgnoresObjectOrderButBindsValuesAndTypes() throws Exception {
        JSONObject first = new JSONObject()
                .put("query", "Moa demo")
                .put("options", new JSONObject().put("autoplay", true).put("count", 1.0))
                .put("ids", new JSONArray().put("a").put("b"));
        JSONObject reordered = new JSONObject()
                .put("ids", new JSONArray().put("a").put("b"))
                .put("options", new JSONObject().put("count", 1).put("autoplay", true))
                .put("query", "Moa demo");
        JSONObject changed = new JSONObject(first.toString()).put("query", "Different");

        assertEquals(
                MoaActionApprovalController.canonicalArgsDigest(first),
                MoaActionApprovalController.canonicalArgsDigest(reordered)
        );
        assertNotEquals(
                MoaActionApprovalController.canonicalArgsDigest(first),
                MoaActionApprovalController.canonicalArgsDigest(changed)
        );
        assertNotEquals(
                MoaActionApprovalController.canonicalArgsDigest(new JSONObject().put("value", 1)),
                MoaActionApprovalController.canonicalArgsDigest(new JSONObject().put("value", "1"))
        );
    }

    @Test
    public void canonicalDigestRejectsOversizedAndDeepArguments() throws Exception {
        StringBuilder oversized = new StringBuilder();
        for (int index = 0; index <= 4096; index += 1) {
            oversized.append('x');
        }
        expectIllegalArgument(() -> MoaActionApprovalController.canonicalArgsDigest(
                new JSONObject().put("value", oversized.toString())
        ));

        JSONObject root = new JSONObject();
        JSONObject cursor = root;
        for (int index = 0; index < 10; index += 1) {
            JSONObject child = new JSONObject();
            cursor.put("child", child);
            cursor = child;
        }
        expectIllegalArgument(() -> MoaActionApprovalController.canonicalArgsDigest(root));
    }

    @Test
    public void navigationAndMediaControlAuthorizeImplicitlyExactlyOnce() throws Exception {
        for (String tool : new String[]{"app.launch", "media.open", "media.control"}) {
            MoaActionApprovalController controller = new MoaActionApprovalController();
            JSONObject args = new JSONObject().put("target", tool);
            MoaActionApprovalController.Binding binding = controller.bind(
                    "request-" + tool,
                    tool,
                    args,
                    "com.google.android.youtube",
                    CREATED,
                    EXPIRES
            );

            assertEquals(MoaActionApprovalController.ApprovalRequirement.IMPLICIT, binding.requirement);
            MoaActionApprovalController.Decision approved = controller.authorizeImplicit(
                    binding.requestId,
                    new JSONObject(args.toString()),
                    "com.google.android.youtube",
                    1_500L
            );
            assertEquals(MoaActionApprovalController.Outcome.APPROVED, approved.outcome);
            assertTrue(approved.mayExecute);

            MoaActionApprovalController.Decision replay = controller.authorizeImplicit(
                    binding.requestId,
                    args,
                    "com.google.android.youtube",
                    1_501L
            );
            assertEquals(MoaActionApprovalController.Outcome.ALREADY_TERMINAL, replay.outcome);
            assertEquals(MoaActionApprovalController.TerminalStatus.APPROVED, replay.terminalStatus);
            assertFalse(replay.mayExecute);
        }
    }

    @Test
    public void playlistMutationWaitsForConfirmationAndCanBeRejectedOnce() throws Exception {
        MoaActionApprovalController controller = new MoaActionApprovalController();
        JSONObject args = new JSONObject()
                .put("operation", "add_video")
                .put("playlist", "Favorites");
        MoaActionApprovalController.Binding binding = controller.bind(
                "playlist-1",
                "media.playlist",
                args,
                "com.google.android.youtube",
                CREATED,
                EXPIRES
        );

        assertEquals(MoaActionApprovalController.ApprovalRequirement.CONFIRMATION_REQUIRED, binding.requirement);
        assertEquals(
                MoaActionApprovalController.Outcome.NEEDS_CONFIRMATION,
                controller.authorizeImplicit(
                        binding.requestId,
                        args,
                        "com.google.android.youtube",
                        1_200L
                ).outcome
        );
        assertEquals(
                MoaActionApprovalController.Outcome.REJECTED,
                controller.reject(binding.requestId, 1_300L).outcome
        );

        MoaActionApprovalController.Decision lateApproval = controller.approve(
                binding.requestId,
                args,
                "com.google.android.youtube",
                1_400L
        );
        assertEquals(MoaActionApprovalController.Outcome.ALREADY_TERMINAL, lateApproval.outcome);
        assertEquals(MoaActionApprovalController.TerminalStatus.REJECTED, lateApproval.terminalStatus);
        assertFalse(lateApproval.mayExecute);
    }

    @Test
    public void bookmarkMutationsRequireConfirmationButReadOnlyAndOpenStayImplicit() throws Exception {
        for (String operation : new String[]{"remember", "save", "delete", "remove"}) {
            assertEquals(
                    MoaActionApprovalController.ApprovalRequirement.CONFIRMATION_REQUIRED,
                    MoaActionApprovalController.approvalRequirement("media.bookmark",
                            new JSONObject().put("operation", operation)));
        }
        for (String operation : new String[]{"list", "open"}) {
            assertEquals(
                    MoaActionApprovalController.ApprovalRequirement.IMPLICIT,
                    MoaActionApprovalController.approvalRequirement("media.bookmark",
                            new JSONObject().put("operation", operation)));
        }
    }

    @Test
    public void confirmedPlaylistMutationRevalidatesDigestAndPackage() throws Exception {
        JSONObject args = new JSONObject().put("operation", "remove_video").put("video_id", "abc");

        MoaActionApprovalController staleArgsController = playlistController("playlist-digest", args);
        MoaActionApprovalController.Decision staleArgs = staleArgsController.approve(
                "playlist-digest",
                new JSONObject(args.toString()).put("video_id", "different"),
                "com.google.android.youtube",
                1_400L
        );
        assertEquals(MoaActionApprovalController.Outcome.STALE, staleArgs.outcome);
        assertFalse(staleArgs.mayExecute);
        assertEquals(
                MoaActionApprovalController.Outcome.ALREADY_TERMINAL,
                staleArgsController.approve(
                        "playlist-digest",
                        args,
                        "com.google.android.youtube",
                        1_401L
                ).outcome
        );

        MoaActionApprovalController stalePackageController = playlistController("playlist-package", args);
        MoaActionApprovalController.Decision stalePackage = stalePackageController.approve(
                "playlist-package",
                args,
                "com.instagram.android",
                1_400L
        );
        assertEquals(MoaActionApprovalController.Outcome.STALE, stalePackage.outcome);
        assertFalse(stalePackage.mayExecute);
    }

    @Test
    public void requestExpiresExactlyOnceAndNeverExecutes() throws Exception {
        MoaActionApprovalController controller = new MoaActionApprovalController();
        JSONObject args = new JSONObject().put("control", "pause");
        controller.bind(
                "expired-1",
                "media.control",
                args,
                "com.google.android.youtube",
                CREATED,
                EXPIRES
        );

        assertEquals(
                MoaActionApprovalController.Outcome.PENDING,
                controller.expire("expired-1", EXPIRES - 1).outcome
        );
        MoaActionApprovalController.Decision expired = controller.authorizeImplicit(
                "expired-1",
                args,
                "com.google.android.youtube",
                EXPIRES
        );
        assertEquals(MoaActionApprovalController.Outcome.EXPIRED, expired.outcome);
        assertFalse(expired.mayExecute);

        MoaActionApprovalController.Decision replay = controller.reject("expired-1", EXPIRES + 1);
        assertEquals(MoaActionApprovalController.Outcome.ALREADY_TERMINAL, replay.outcome);
        assertEquals(MoaActionApprovalController.TerminalStatus.EXPIRED, replay.terminalStatus);
    }

    @Test
    public void readOnlyPlaylistIsImplicitButUnknownToolsFailClosed() throws Exception {
        assertEquals(
                MoaActionApprovalController.ApprovalRequirement.CONFIRMATION_REQUIRED,
                MoaActionApprovalController.approvalRequirement(
                        "screen.set_text", new JSONObject().put("label", "Message"))
        );
        assertEquals(
                MoaActionApprovalController.ApprovalRequirement.IMPLICIT,
                MoaActionApprovalController.approvalRequirement(
                        "media.playlist",
                        new JSONObject().put("operation", "list")
                )
        );
        assertEquals(
                MoaActionApprovalController.ApprovalRequirement.BLOCKED,
                MoaActionApprovalController.approvalRequirement("device.shell", new JSONObject())
        );

        MoaActionApprovalController controller = new MoaActionApprovalController();
        expectIllegalArgument(() -> controller.bind(
                "unknown-1",
                "device.shell",
                new JSONObject(),
                "com.example",
                CREATED,
                EXPIRES
        ));
    }

    @Test
    public void malformedBindingsAndDuplicateRequestIdsAreRejected() throws Exception {
        MoaActionApprovalController controller = new MoaActionApprovalController();
        JSONObject args = new JSONObject().put("control", "pause");
        expectIllegalArgument(() -> controller.bind(
                "missing-package",
                "media.control",
                args,
                "",
                CREATED,
                EXPIRES
        ));
        expectIllegalArgument(() -> controller.bind(
                "bad-expiry",
                "media.control",
                args,
                "com.google.android.youtube",
                CREATED,
                CREATED
        ));

        controller.bind(
                "duplicate",
                "media.control",
                args,
                "com.google.android.youtube",
                CREATED,
                EXPIRES
        );
        try {
            controller.bind(
                    "duplicate",
                    "media.control",
                    args,
                    "com.google.android.youtube",
                    CREATED,
                    EXPIRES
            );
            fail("Expected duplicate request id to fail");
        } catch (IllegalStateException expected) {
            assertTrue(expected.getMessage().contains("already bound"));
        }
    }

    private static MoaActionApprovalController playlistController(String id, JSONObject args) {
        MoaActionApprovalController controller = new MoaActionApprovalController();
        controller.bind(
                id,
                "media.playlist",
                args,
                "com.google.android.youtube",
                CREATED,
                EXPIRES
        );
        return controller;
    }

    private static void expectIllegalArgument(ThrowingRunnable action) {
        try {
            action.run();
            fail("Expected IllegalArgumentException");
        } catch (IllegalArgumentException expected) {
            // Expected.
        } catch (Exception other) {
            throw new AssertionError(other);
        }
    }

    private interface ThrowingRunnable {
        void run() throws Exception;
    }
}
