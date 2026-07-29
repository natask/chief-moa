package ag.companion;

import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;

import org.json.JSONObject;

import java.text.Normalizer;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/** Device-local policy for resolving visible launcher labels to explicit activities. */
final class MoaAppLaunchPolicy {
    static final int DEFAULT_LIST_LIMIT = 40;
    static final int MAX_LIST_LIMIT = 120;
    static final int MAX_LABEL_CHARS = 80;
    static final int MAX_AMBIGUOUS_LABELS = 4;
    static final int MAX_LIST_LABEL_CHARS = 1_600;

    private static final int MAX_COMPONENT_CHARS = 500;
    private static final Set<String> TOOL_LABEL_KEYS = Set.of(
            "app_name", "appName", "name", "app");
    private static final Pattern APPLICATION_ID = Pattern.compile(
            "(?i)^[a-z][a-z0-9_]*(?:\\.[a-z][a-z0-9_]*)+$");

    private MoaAppLaunchPolicy() {
    }

    static Resolution resolveToolInput(JSONObject input, List<Candidate> installed) {
        JSONObject args = input == null ? new JSONObject() : input;
        java.util.Iterator<String> keys = args.keys();
        while (keys.hasNext()) {
            if (!TOOL_LABEL_KEYS.contains(keys.next())) return Resolution.rawApplicationId();
        }
        String requested = firstNonEmpty(
                args.optString("app_name", ""),
                args.optString("appName", ""),
                args.optString("name", ""),
                args.optString("app", ""));
        String normalized = normalizeLabel(requested);
        for (String key : TOOL_LABEL_KEYS) {
            String alias = args.optString(key, "").trim();
            if (!alias.isEmpty() && !normalizeLabel(alias).equals(normalized)) {
                return Resolution.invalid();
            }
        }
        return resolve(requested, installed);
    }

    static Resolution resolve(String requestedLabel, List<Candidate> installed) {
        String label = visibleLabel(requestedLabel);
        if (label.isEmpty()) {
            return Resolution.invalid();
        }
        if (looksLikeApplicationId(label)) {
            return Resolution.rawApplicationId();
        }

        String normalizedTarget = normalizeLabel(label);
        if (normalizedTarget.isEmpty()) {
            return Resolution.invalid();
        }
        List<Candidate> exact = new ArrayList<>();
        List<Candidate> highConfidence = new ArrayList<>();
        for (Candidate candidate : stableCandidates(installed)) {
            String normalizedLabel = normalizeLabel(candidate.label);
            if (normalizedLabel.equals(normalizedTarget)) {
                exact.add(candidate);
            } else if (isHighConfidenceLabelMatch(normalizedTarget, normalizedLabel)) {
                highConfidence.add(candidate);
            }
        }
        return choose(exact.isEmpty() ? highConfidence : exact);
    }

    static LabelProjection projectVisibleLabels(List<Candidate> installed, int requestedLimit) {
        Map<String, String> unique = new LinkedHashMap<>();
        for (Candidate candidate : stableCandidates(installed)) {
            unique.putIfAbsent(normalizeLabel(candidate.label), candidate.label);
        }
        List<String> projected = new ArrayList<>();
        int usedCharacters = 0;
        int limit = boundedListLimit(requestedLimit);
        for (String label : unique.values()) {
            int addedCharacters = label.length() + (projected.isEmpty() ? 0 : 2);
            if (projected.size() >= limit || usedCharacters + addedCharacters > MAX_LIST_LABEL_CHARS) {
                break;
            }
            projected.add(label);
            usedCharacters += addedCharacters;
        }
        return new LabelProjection(projected, unique.size());
    }

    static List<Candidate> installedLauncherCandidates(PackageManager packageManager) {
        if (packageManager == null) {
            return Collections.emptyList();
        }
        Intent query = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
        List<ResolveInfo> activities;
        try {
            activities = packageManager.queryIntentActivities(query, 0);
        } catch (RuntimeException unavailable) {
            return Collections.emptyList();
        }
        if (activities == null || activities.isEmpty()) {
            return Collections.emptyList();
        }

        List<Candidate> candidates = new ArrayList<>();
        for (ResolveInfo info : activities) {
            if (info == null || info.activityInfo == null) {
                continue;
            }
            String packageName = boundedComponent(info.activityInfo.packageName);
            String activityName = boundedComponent(info.activityInfo.name);
            if (packageName.isEmpty() || activityName.isEmpty()) {
                continue;
            }
            CharSequence loaded;
            try {
                loaded = info.loadLabel(packageManager);
            } catch (RuntimeException unavailable) {
                continue;
            }
            String label = visibleLabel(loaded == null ? "" : loaded.toString());
            if (!label.isEmpty()) {
                candidates.add(new Candidate(label, packageName, activityName));
            }
        }
        return stableCandidates(candidates);
    }

    static Intent explicitLauncherIntent(Candidate candidate) {
        return new Intent(Intent.ACTION_MAIN)
                .addCategory(Intent.CATEGORY_LAUNCHER)
                .setClassName(candidate.packageName, candidate.activityName)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    }

    static boolean looksLikeApplicationId(String value) {
        String target = value == null ? "" : value.trim();
        if (target.isEmpty()) {
            return false;
        }
        String lower = target.toLowerCase(Locale.US);
        if (lower.startsWith("package:") || lower.startsWith("intent:")
                || lower.contains("://") || lower.contains("#intent;")
                || target.contains("/") || target.startsWith(".")) {
            return true;
        }
        return APPLICATION_ID.matcher(target).matches();
    }

    static String normalizeLabel(String value) {
        String label = Normalizer.normalize(
                value == null ? "" : value.trim(), Normalizer.Form.NFKC).toLowerCase(Locale.ROOT);
        StringBuilder normalized = new StringBuilder();
        boolean pendingSpace = false;
        for (int index = 0; index < label.length();) {
            int codePoint = label.codePointAt(index);
            index += Character.charCount(codePoint);
            if (Character.isLetterOrDigit(codePoint)) {
                if (pendingSpace && normalized.length() > 0) normalized.append(' ');
                normalized.appendCodePoint(codePoint);
                pendingSpace = false;
            } else if (isVisibleSymbol(codePoint)) {
                if (pendingSpace && normalized.length() > 0) normalized.append(' ');
                normalized.appendCodePoint(codePoint);
                pendingSpace = false;
            } else {
                pendingSpace = normalized.length() > 0;
            }
        }
        return normalized.toString();
    }

    static int boundedListLimit(int requestedLimit) {
        if (requestedLimit <= 0) {
            return DEFAULT_LIST_LIMIT;
        }
        return Math.min(requestedLimit, MAX_LIST_LIMIT);
    }

    static String formatListReply(List<String> labels, int total) {
        if (labels == null || labels.isEmpty() || total <= 0) {
            return "No launcher apps were visible.";
        }
        StringBuilder reply = new StringBuilder();
        if (labels.size() < total) {
            reply.append("Installed apps (").append(labels.size()).append(" of ")
                    .append(total).append("): ");
        } else {
            reply.append("Installed apps: ");
        }
        for (int index = 0; index < labels.size(); index += 1) {
            if (index > 0) {
                reply.append(", ");
            }
            reply.append(labels.get(index));
        }
        return reply.append(". Say /open app <name> to launch one.").toString();
    }

    private static Resolution choose(List<Candidate> matches) {
        if (matches.isEmpty()) {
            return Resolution.notFound();
        }
        if (matches.size() == 1) {
            return Resolution.match(matches.get(0));
        }
        Map<String, String> labels = new LinkedHashMap<>();
        for (Candidate candidate : matches) {
            labels.putIfAbsent(normalizeLabel(candidate.label), candidate.label);
            if (labels.size() >= MAX_AMBIGUOUS_LABELS) {
                break;
            }
        }
        return Resolution.ambiguous(new ArrayList<>(labels.values()));
    }

    private static boolean isHighConfidenceLabelMatch(String target, String label) {
        if (target.length() < 4 || label.length() < 4) {
            return false;
        }
        return containsWholePhrase(label, target) || containsWholePhrase(target, label);
    }

    private static boolean containsWholePhrase(String value, String phrase) {
        return (" " + value + " ").contains(" " + phrase + " ");
    }

    private static List<Candidate> stableCandidates(List<Candidate> installed) {
        if (installed == null || installed.isEmpty()) {
            return Collections.emptyList();
        }
        List<Candidate> sanitized = new ArrayList<>();
        for (Candidate item : installed) {
            Candidate candidate = sanitizeCandidate(item);
            if (candidate != null) {
                sanitized.add(candidate);
            }
        }
        sanitized.sort((left, right) -> {
            int label = normalizeLabel(left.label).compareTo(normalizeLabel(right.label));
            if (label != 0) return label;
            int packageName = left.packageName.compareTo(right.packageName);
            return packageName != 0 ? packageName : left.activityName.compareTo(right.activityName);
        });
        Map<String, Candidate> unique = new LinkedHashMap<>();
        for (Candidate candidate : sanitized) {
            unique.putIfAbsent(candidate.packageName + "\n" + normalizeLabel(candidate.label), candidate);
        }
        return new ArrayList<>(unique.values());
    }

    private static Candidate sanitizeCandidate(Candidate candidate) {
        if (candidate == null) {
            return null;
        }
        String label = visibleLabel(candidate.label);
        String packageName = boundedComponent(candidate.packageName);
        String activityName = boundedComponent(candidate.activityName);
        if (label.isEmpty() || packageName.isEmpty() || activityName.isEmpty()) {
            return null;
        }
        return new Candidate(label, packageName, activityName);
    }

    private static String visibleLabel(String value) {
        String raw = value == null ? "" : value;
        for (int index = 0; index < raw.length();) {
            int codePoint = raw.codePointAt(index);
            index += Character.charCount(codePoint);
            int type = Character.getType(codePoint);
            if (Character.isISOControl(codePoint) || type == Character.FORMAT
                    || type == Character.LINE_SEPARATOR || type == Character.PARAGRAPH_SEPARATOR
                    || type == Character.SURROGATE || type == Character.UNASSIGNED) {
                return "";
            }
        }
        String label = raw.trim().replaceAll("\\s+", " ");
        return label.isEmpty() || label.length() > MAX_LABEL_CHARS ? "" : label;
    }

    private static String boundedComponent(String value) {
        String component = value == null ? "" : value.trim();
        return component.length() <= MAX_COMPONENT_CHARS ? component : "";
    }

    private static String firstNonEmpty(String... values) {
        for (String value : values) {
            if (value != null && !value.trim().isEmpty()) {
                return value.trim();
            }
        }
        return "";
    }

    private static boolean isVisibleSymbol(int codePoint) {
        int type = Character.getType(codePoint);
        return type == Character.MATH_SYMBOL || type == Character.CURRENCY_SYMBOL
                || type == Character.MODIFIER_SYMBOL || type == Character.OTHER_SYMBOL;
    }

    enum Status {
        MATCH,
        NOT_FOUND,
        AMBIGUOUS,
        INVALID_LABEL,
        RAW_APPLICATION_ID
    }

    static final class Candidate {
        final String label;
        final String packageName;
        final String activityName;

        Candidate(String label, String packageName, String activityName) {
            this.label = label;
            this.packageName = packageName;
            this.activityName = activityName;
        }
    }

    static final class Resolution {
        final Status status;
        final Candidate candidate;
        final List<String> candidateLabels;

        private Resolution(Status status, Candidate candidate, List<String> candidateLabels) {
            this.status = status;
            this.candidate = candidate;
            this.candidateLabels = Collections.unmodifiableList(candidateLabels);
        }

        static Resolution match(Candidate candidate) {
            return new Resolution(Status.MATCH, candidate, Collections.emptyList());
        }

        static Resolution notFound() {
            return new Resolution(Status.NOT_FOUND, null, Collections.emptyList());
        }

        static Resolution ambiguous(List<String> labels) {
            return new Resolution(Status.AMBIGUOUS, null, labels);
        }

        static Resolution invalid() {
            return new Resolution(Status.INVALID_LABEL, null, Collections.emptyList());
        }

        static Resolution rawApplicationId() {
            return new Resolution(Status.RAW_APPLICATION_ID, null, Collections.emptyList());
        }
    }

    static final class LabelProjection {
        final List<String> labels;
        final int total;

        LabelProjection(List<String> labels, int total) {
            this.labels = Collections.unmodifiableList(labels);
            this.total = total;
        }
    }
}
