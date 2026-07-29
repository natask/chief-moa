package ag.companion;

import org.junit.Test;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

public final class MoaAppLaunchPolicyTest {
    @Test
    public void exactVisibleLabelSelectsInstalledLauncherActivity() {
        MoaAppLaunchPolicy.Resolution result = MoaAppLaunchPolicy.resolve(
                "  Google   Chrome ",
                Arrays.asList(
                        app("Chrome Beta", "com.chrome.beta", "Beta"),
                        app("Google Chrome", "com.android.chrome", "Main")));

        assertEquals(MoaAppLaunchPolicy.Status.MATCH, result.status);
        assertEquals("Google Chrome", result.candidate.label);
        assertEquals("com.android.chrome", result.candidate.packageName);
        assertEquals("Main", result.candidate.activityName);
    }

    @Test
    public void uniqueWholeLabelPhraseIsHighConfidenceButAmbiguityFailsClosed() {
        MoaAppLaunchPolicy.Resolution unique = MoaAppLaunchPolicy.resolve(
                "Chrome", List.of(app("Google Chrome", "com.android.chrome", "Main")));
        assertEquals(MoaAppLaunchPolicy.Status.MATCH, unique.status);

        MoaAppLaunchPolicy.Resolution ambiguous = MoaAppLaunchPolicy.resolve(
                "YouTube",
                Arrays.asList(
                        app("YouTube Advanced", "app.revanced.android.youtube", "Main"),
                        app("YouTube Music", "com.google.android.apps.youtube.music", "Main")));
        assertEquals(MoaAppLaunchPolicy.Status.AMBIGUOUS, ambiguous.status);
        assertNull(ambiguous.candidate);
        assertEquals(List.of("YouTube Advanced", "YouTube Music"), ambiguous.candidateLabels);

        assertEquals(MoaAppLaunchPolicy.Status.NOT_FOUND,
                MoaAppLaunchPolicy.resolve("tube", Arrays.asList(
                        app("YouTube Advanced", "app.revanced.android.youtube", "Main"))).status);
    }

    @Test
    public void duplicateActivitiesWithinOneAppDoNotCreateFalseAmbiguity() {
        MoaAppLaunchPolicy.Resolution result = MoaAppLaunchPolicy.resolve(
                "Maps", Arrays.asList(
                        app("Maps", "com.example.maps", "AliasActivity"),
                        app("Maps", "com.example.maps", "MainActivity")));

        assertEquals(MoaAppLaunchPolicy.Status.MATCH, result.status);
        assertEquals("AliasActivity", result.candidate.activityName);
    }

    @Test
    public void unicodeVisibleLabelsResolveExactly() {
        MoaAppLaunchPolicy.Resolution result = MoaAppLaunchPolicy.resolve(
                "カメラ", Arrays.asList(
                        app("カメラ", "jp.example.camera", "Main"),
                        app("音楽", "jp.example.music", "Main")));

        assertEquals(MoaAppLaunchPolicy.Status.MATCH, result.status);
        assertEquals("カメラ", result.candidate.label);

        assertEquals(MoaAppLaunchPolicy.Status.MATCH,
                MoaAppLaunchPolicy.resolve("Chrome",
                        List.of(app("Ｃｈｒｏｍｅ", "com.example.fullwidth", "Main"))).status);
        assertEquals(MoaAppLaunchPolicy.Status.MATCH,
                MoaAppLaunchPolicy.resolve("📷",
                        List.of(app("📷", "com.example.emoji", "Main"))).status);
        assertEquals(MoaAppLaunchPolicy.Status.INVALID_LABEL,
                MoaAppLaunchPolicy.resolve("Safe\u202EApp",
                        List.of(app("Safe App", "com.example.safe", "Main"))).status);
    }

    @Test
    public void rawPackageAndApplicationIdentifiersNeverResolve() {
        List<MoaAppLaunchPolicy.Candidate> installed = Arrays.asList(
                app("Google Chrome", "com.android.chrome", "Main"),
                app("YouTube", "app.revanced.android.youtube", "Main"));

        assertEquals(MoaAppLaunchPolicy.Status.RAW_APPLICATION_ID,
                MoaAppLaunchPolicy.resolve("com.android.chrome", installed).status);
        assertEquals(MoaAppLaunchPolicy.Status.RAW_APPLICATION_ID,
                MoaAppLaunchPolicy.resolve("app.revanced.android.youtube", installed).status);
        assertEquals(MoaAppLaunchPolicy.Status.RAW_APPLICATION_ID,
                MoaAppLaunchPolicy.resolve("com.android.chrome/Main", installed).status);
        assertEquals(MoaAppLaunchPolicy.Status.RAW_APPLICATION_ID,
                MoaAppLaunchPolicy.resolve("Chrome/MainActivity", installed).status);
    }

    @Test
    public void toolInputAcceptsVisibleNameAliasesButRejectsPackageAuthority() throws Exception {
        List<MoaAppLaunchPolicy.Candidate> installed =
                List.of(app("Google Chrome", "com.android.chrome", "Main"));

        assertEquals(MoaAppLaunchPolicy.Status.MATCH,
                MoaAppLaunchPolicy.resolveToolInput(
                        new JSONObject().put("app_name", "Google Chrome"), installed).status);
        assertEquals(MoaAppLaunchPolicy.Status.MATCH,
                MoaAppLaunchPolicy.resolveToolInput(
                        new JSONObject().put("name", "Google Chrome"), installed).status);
        assertEquals(MoaAppLaunchPolicy.Status.MATCH,
                MoaAppLaunchPolicy.resolveToolInput(
                        new JSONObject().put("app", "Google Chrome"), installed).status);
        assertEquals(MoaAppLaunchPolicy.Status.RAW_APPLICATION_ID,
                MoaAppLaunchPolicy.resolveToolInput(
                        new JSONObject().put("app_name", "Google Chrome")
                                .put("package", "com.android.chrome"), installed).status);
        assertEquals(MoaAppLaunchPolicy.Status.RAW_APPLICATION_ID,
                MoaAppLaunchPolicy.resolveToolInput(
                        new JSONObject().put("app_name", "Google Chrome")
                                .put("component", "com.android.chrome/Main"), installed).status);
        assertEquals(MoaAppLaunchPolicy.Status.RAW_APPLICATION_ID,
                MoaAppLaunchPolicy.resolveToolInput(
                        new JSONObject().put("app_name", "Google Chrome")
                                .put("target", "Google Chrome"), installed).status);
        assertEquals(MoaAppLaunchPolicy.Status.INVALID_LABEL,
                MoaAppLaunchPolicy.resolveToolInput(
                        new JSONObject().put("app_name", "Google Chrome")
                                .put("name", "Gmail"), installed).status);
    }

    @Test
    public void appListProjectionIsSortedDeduplicatedBoundedAndLabelsOnly() {
        List<MoaAppLaunchPolicy.Candidate> installed = new ArrayList<>();
        installed.add(app("Maps", "com.example.maps", "Main"));
        installed.add(app("Chrome", "com.android.chrome", "Main"));
        installed.add(app("chrome", "org.example.chrome", "Main"));
        installed.add(app("", "com.secret.empty", "Main"));
        for (int index = 0; index < 150; index += 1) {
            installed.add(app(String.format("Tool %03d", index),
                    "com.example.tool" + index, "Main"));
        }

        MoaAppLaunchPolicy.LabelProjection projection =
                MoaAppLaunchPolicy.projectVisibleLabels(installed, 500);

        assertEquals(MoaAppLaunchPolicy.MAX_LIST_LIMIT, projection.labels.size());
        assertEquals(152, projection.total);
        assertEquals("Chrome", projection.labels.get(0));
        assertEquals("Maps", projection.labels.get(1));
        for (String label : projection.labels) {
            org.junit.Assert.assertFalse(label.startsWith("com."));
        }
    }

    @Test
    public void labelAndAggregateProjectionBudgetsFailClosed() {
        assertEquals(MoaAppLaunchPolicy.Status.INVALID_LABEL,
                MoaAppLaunchPolicy.resolve("x".repeat(81),
                        List.of(app("Example", "com.example", "Main"))).status);

        List<MoaAppLaunchPolicy.Candidate> installed = new ArrayList<>();
        for (int index = 0; index < 40; index += 1) {
            installed.add(app(String.format("%02d ", index) + "x".repeat(70),
                    "com.example.long" + index, "Main"));
        }
        MoaAppLaunchPolicy.LabelProjection projection =
                MoaAppLaunchPolicy.projectVisibleLabels(installed, 120);
        int projectedCharacters = String.join(", ", projection.labels).length();

        assertEquals(40, projection.total);
        org.junit.Assert.assertTrue(projection.labels.size() < projection.total);
        org.junit.Assert.assertTrue(projectedCharacters <= MoaAppLaunchPolicy.MAX_LIST_LABEL_CHARS);
    }

    @Test
    public void ambiguousCandidateProjectionNeverLeaksPackagesAndIsBounded() {
        List<MoaAppLaunchPolicy.Candidate> installed = new ArrayList<>();
        for (int index = 0; index < 10; index += 1) {
            installed.add(app("Video Player " + index, "com.secret.player" + index, "Main"));
        }

        MoaAppLaunchPolicy.Resolution duplicateLabels = MoaAppLaunchPolicy.resolve(
                "Player", Arrays.asList(
                        app("Player", "com.example.one", "Main"),
                        app("Player", "com.example.two", "Main")));
        assertEquals(MoaAppLaunchPolicy.Status.AMBIGUOUS, duplicateLabels.status);
        assertNull(duplicateLabels.candidate);
        MoaAppLaunchPolicy.Resolution result = MoaAppLaunchPolicy.resolve("Video Player", installed);

        assertEquals(MoaAppLaunchPolicy.Status.AMBIGUOUS, result.status);
        assertEquals(MoaAppLaunchPolicy.MAX_AMBIGUOUS_LABELS, result.candidateLabels.size());
        for (String label : result.candidateLabels) {
            org.junit.Assert.assertFalse(label.contains("com.secret"));
        }
    }

    private static MoaAppLaunchPolicy.Candidate app(
            String label, String packageName, String activityName) {
        return new MoaAppLaunchPolicy.Candidate(label, packageName, activityName);
    }
}
