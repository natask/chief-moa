package ai.moa.assistant;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.provider.ContactsContract;

import org.json.JSONException;
import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

final class MoaActionBroker {
    private static final String RISK_READ_ONLY = "read_only";
    private static final String RISK_NAVIGATION = "navigation";
    private static final String RISK_EXTERNAL_SIDE_EFFECT = "external_side_effect";
    private static final String APPROVAL_IMPLICIT = "implicit_user_command";
    private static final String APPROVAL_TARGET_APP_CONFIRMATION = "target_app_confirmation";
    private static final int DEFAULT_APP_LIST_LIMIT = 40;
    private static final int MAX_APP_LIST_LIMIT = 120;
    private static final Map<String, Capability> CAPABILITIES = createCapabilityManifest();

    private final Context context;

    MoaActionBroker(Context context) {
        this.context = context.getApplicationContext();
    }

    LocalActionResult tryHandleLocalCommand(String text) {
        String trimmed = safe(text);
        String lower = trimmed.toLowerCase(Locale.US);

        if (lower.equals("/screen")) {
            Capability capability = CAPABILITIES.get("screen.summary");
            if (!MoaAccessibilityService.isRunning()) {
                return LocalActionResult.handled("Screen access is not running. Open A.G. and enable screen access in Android accessibility settings.");
            }
            String summary = MoaAccessibilityService.currentScreenSummary();
            if (summary.isEmpty()) {
                recordReceipt(capability, "", false, "No visible screen text was available.");
                return LocalActionResult.handled("Screen access is running, but I could not read visible text from the active window.");
            }
            recordReceipt(capability, "", true, "Screen summary returned.");
            return LocalActionResult.handled("Current screen: " + summary);
        }

        if (lower.startsWith("/tap ")) {
            Capability capability = CAPABILITIES.get("screen.tap_text");
            String label = trimmed.substring("/tap ".length()).trim();
            if (label.isEmpty()) {
                return LocalActionResult.handled("Tell me the visible label to tap, like /tap Allow.");
            }
            if (!MoaAccessibilityService.isRunning()) {
                recordReceipt(capability, label, false, "Screen access is not running.");
                return LocalActionResult.handled("Screen access is not running. Enable it before using /tap.");
            }
            String expectedPackage = currentPackageName();
            MoaAccessibilityService.TapResult tapResult = MoaAccessibilityService.clickByText(label, expectedPackage);
            if (tapResult == MoaAccessibilityService.TapResult.CLICKED) {
                recordReceipt(capability, label, true, "Tapped visible label.");
                return LocalActionResult.handled("Tapped \"" + label + "\".");
            }
            if (tapResult == MoaAccessibilityService.TapResult.STALE_TARGET) {
                recordReceipt(capability, label, false, "Active app changed before execution.");
                return LocalActionResult.handled("The active app changed before I could tap. Please try again on the intended screen.");
            }
            recordReceipt(capability, label, false, "No visible clickable match.");
            return LocalActionResult.handled("I could not find a visible clickable item matching \"" + label + "\".");
        }

        if (lower.equals("/back")) {
            Capability capability = CAPABILITIES.get("system.back");
            if (!MoaAccessibilityService.isRunning()) {
                recordReceipt(capability, "", false, "Screen access is not running.");
                return LocalActionResult.handled("Screen access is not running. Enable it before using /back.");
            }
            boolean success = MoaAccessibilityService.performBack();
            recordReceipt(capability, "", success, success ? "Pressed back." : "Back action failed.");
            return LocalActionResult.handled(success ? "Pressed back." : "I could not press back from here.");
        }

        if (lower.equals("/home")) {
            Capability capability = CAPABILITIES.get("system.home");
            if (!MoaAccessibilityService.isRunning()) {
                recordReceipt(capability, "", false, "Screen access is not running.");
                return LocalActionResult.handled("Screen access is not running. Enable it before using /home.");
            }
            boolean success = MoaAccessibilityService.performHome();
            recordReceipt(capability, "", success, success ? "Pressed home." : "Home action failed.");
            return LocalActionResult.handled(success ? "Pressed home." : "I could not press home from here.");
        }

        if (isAppListCommand(trimmed)) {
            return listLauncherAppsForCommand();
        }

        String appTarget = openAppTarget(trimmed);
        if (!appTarget.isEmpty()) {
            return openLauncherApp(appTarget);
        }

        return LocalActionResult.notHandled();
    }

    ToolExecutionResult executeToolRequest(String tool, JSONObject input) {
        String name = safe(tool).toLowerCase(Locale.US);
        JSONObject args = input == null ? new JSONObject() : input;

        if ("screen.summary".equals(name)) {
            Capability capability = CAPABILITIES.get("screen.summary");
            if (!MoaAccessibilityService.isRunning()) {
                JSONObject receipt = recordReceipt(capability, "", false, "Screen access is not running.");
                return ToolExecutionResult.done(false, "Screen access is not running.", receipt);
            }
            String summary = MoaAccessibilityService.currentScreenSummary();
            if (summary.isEmpty()) {
                JSONObject receipt = recordReceipt(capability, "", false, "No visible screen text was available.");
                return ToolExecutionResult.done(false, "No visible screen text was available.", receipt);
            }
            JSONObject receipt = recordReceipt(capability, "", true, "Screen summary returned.");
            return ToolExecutionResult.done(true, "Current screen: " + summary, receipt);
        }

        if ("screen.tap_text".equals(name)) {
            Capability capability = CAPABILITIES.get("screen.tap_text");
            String label = safe(args.optString("text", args.optString("label", args.optString("target", ""))));
            if (label.isEmpty()) {
                JSONObject receipt = recordReceipt(capability, "", false, "Visible label is required.");
                return ToolExecutionResult.done(false, "Visible label is required.", receipt);
            }
            if (!MoaAccessibilityService.isRunning()) {
                JSONObject receipt = recordReceipt(capability, label, false, "Screen access is not running.");
                return ToolExecutionResult.done(false, "Screen access is not running.", receipt);
            }
            String expectedPackage = expectedPackage(args);
            if (expectedPackage.isEmpty()) {
                JSONObject receipt = recordReceipt(capability, label, false, "Expected package is required for a screen-bound action.");
                return ToolExecutionResult.done(false, "expected_package is required for screen.tap_text.", receipt);
            }
            MoaAccessibilityService.TapResult tapResult = MoaAccessibilityService.clickByText(label, expectedPackage);
            if (tapResult == MoaAccessibilityService.TapResult.STALE_TARGET) {
                JSONObject receipt = recordReceipt(capability, label, false, "Active app no longer matches expected package.");
                return ToolExecutionResult.done(false, "The active app changed; screen.tap_text was not executed.", receipt);
            }
            boolean clicked = tapResult == MoaAccessibilityService.TapResult.CLICKED;
            String result = clicked ? "Tapped visible label." : "No visible clickable match.";
            JSONObject receipt = recordReceipt(capability, label, clicked, result);
            return ToolExecutionResult.done(clicked, clicked ? "Tapped \"" + label + "\"." : "No visible clickable item matched \"" + label + "\".", receipt);
        }

        if ("system.back".equals(name)) {
            Capability capability = CAPABILITIES.get("system.back");
            if (!MoaAccessibilityService.isRunning()) {
                JSONObject receipt = recordReceipt(capability, "", false, "Screen access is not running.");
                return ToolExecutionResult.done(false, "Screen access is not running.", receipt);
            }
            boolean success = MoaAccessibilityService.performBack();
            JSONObject receipt = recordReceipt(capability, "", success, success ? "Pressed back." : "Back action failed.");
            return ToolExecutionResult.done(success, success ? "Pressed back." : "Back action failed.", receipt);
        }

        if ("system.home".equals(name)) {
            Capability capability = CAPABILITIES.get("system.home");
            if (!MoaAccessibilityService.isRunning()) {
                JSONObject receipt = recordReceipt(capability, "", false, "Screen access is not running.");
                return ToolExecutionResult.done(false, "Screen access is not running.", receipt);
            }
            boolean success = MoaAccessibilityService.performHome();
            JSONObject receipt = recordReceipt(capability, "", success, success ? "Pressed home." : "Home action failed.");
            return ToolExecutionResult.done(success, success ? "Pressed home." : "Home action failed.", receipt);
        }

        if ("app.launch".equals(name)) {
            String target = safe(args.optString("app", args.optString("name", args.optString("target", args.optString("package", "")))));
            if (target.isEmpty()) {
                Capability capability = CAPABILITIES.get("app.launch");
                JSONObject receipt = recordReceipt(capability, "", false, "App target is required.");
                return ToolExecutionResult.done(false, "App target is required.", receipt);
            }
            return openLauncherAppForTool(target);
        }

        if ("app.list".equals(name)) {
            return listLauncherAppsForTool(args);
        }

        if ("email.compose".equals(name)) {
            return composeEmailDraft(args);
        }

        if ("sms.compose".equals(name)) {
            return composeSmsDraft(args);
        }

        if ("url.open".equals(name)) {
            return openUrlForTool(args);
        }

        if ("phone.dial".equals(name)) {
            return dialNumberForTool(args);
        }

        if ("contact.open".equals(name)) {
            return openContactForTool(args);
        }

        return ToolExecutionResult.done(false, "Unsupported local tool: " + name + ".", null);
    }

    JSONObject screenSnapshot() {
        return MoaAccessibilityService.currentScreenSnapshot();
    }

    JSONObject activeAppDescriptor() {
        return MoaAccessibilityService.currentActiveAppDescriptor();
    }

    JSONArray executionAdapters() {
        return MoaAccessibilityService.currentExecutionAdapters();
    }

    String currentScreenSummary() {
        return MoaAccessibilityService.currentScreenSummary();
    }

    void putScreenContext(JSONObject body) throws JSONException {
        JSONObject screen = screenSnapshot();
        if (screen != null) {
            body.put("screen", screen);
        }
    }

    static String expectedPackage(JSONObject input) {
        JSONObject args = input == null ? new JSONObject() : input;
        return safe(args.optString("expected_package", args.optString("expectedPackage", "")));
    }

    private static String currentPackageName() {
        JSONObject descriptor = MoaAccessibilityService.currentActiveAppDescriptor();
        return safe(descriptor.optString("package_name", ""));
    }

    String promptWithScreenContext(String prompt) {
        String summary = MoaAccessibilityService.currentScreenSummary();
        if (summary.isEmpty()) {
            return prompt;
        }
        return prompt + "\n\nCurrent Android screen context:\n" + summary;
    }

    boolean isScreenAccessEnabled() {
        return MoaAccessibilityService.isEnabled(context);
    }

    boolean isScreenAccessRunning() {
        return MoaAccessibilityService.isRunning();
    }

    JSONObject capabilityManifest() {
        JSONObject manifest = new JSONObject();
        for (Capability capability : CAPABILITIES.values()) {
            try {
                JSONObject item = new JSONObject();
                item.put("tool", capability.tool);
                item.put("risk", capability.risk);
                item.put("approval", capability.approval);
                manifest.put(capability.tool, item);
            } catch (JSONException ignored) {
            }
        }
        return manifest;
    }

    boolean rejectsModelProposal(JSONObject proposal) {
        if (proposal == null) {
            return true;
        }
        String tool = safe(proposal.optString("tool", proposal.optString("name", "")));
        Capability capability = CAPABILITIES.get(tool);
        return capability == null || "blocked".equals(capability.approval);
    }

    private JSONObject recordReceipt(Capability capability, String target, boolean success, String result) {
        if (capability == null) {
            return null;
        }
        return MoaActionReceiptStore.record(context, capability.tool, capability.risk, capability.approval, target, success, result);
    }

    private LocalActionResult listLauncherAppsForCommand() {
        return LocalActionResult.handled(listLauncherAppsForTool(new JSONObject()).reply);
    }

    private ToolExecutionResult listLauncherAppsForTool(JSONObject args) {
        Capability capability = CAPABILITIES.get("app.list");
        List<String> labels = launcherAppLabels(context.getPackageManager());
        String reply = formatAppListReply(labels, args.optInt("limit", DEFAULT_APP_LIST_LIMIT));
        JSONObject receipt = recordReceipt(capability, "launcher_apps", true, "Listed " + labels.size() + " launcher apps.");
        return ToolExecutionResult.done(true, reply, receipt);
    }

    private LocalActionResult openLauncherApp(String target) {
        return LocalActionResult.handled(openLauncherAppForTool(target).reply);
    }

    private ToolExecutionResult openLauncherAppForTool(String target) {
        Capability capability = CAPABILITIES.get("app.launch");
        PackageManager packageManager = context.getPackageManager();
        List<AppCandidate> matches = matchingLauncherApps(packageManager, target);
        if (matches.isEmpty()) {
            JSONObject receipt = recordReceipt(capability, target, false, "No matching launcher app.");
            return ToolExecutionResult.done(false, "I could not find an installed app matching \"" + target + "\".", receipt);
        }
        if (matches.size() > 1) {
            StringBuilder names = new StringBuilder();
            for (int i = 0; i < Math.min(matches.size(), 4); i += 1) {
                if (i > 0) {
                    names.append(", ");
                }
                names.append(matches.get(i).label);
            }
            JSONObject receipt = recordReceipt(capability, target, false, "Multiple launcher app matches.");
            return ToolExecutionResult.done(false, "I found multiple apps matching \"" + target + "\": " + names + ". Say the full app name.", receipt);
        }

        AppCandidate app = matches.get(0);
        Intent launchIntent = packageManager.getLaunchIntentForPackage(app.packageName);
        if (launchIntent == null) {
            launchIntent = new Intent(Intent.ACTION_MAIN);
            launchIntent.addCategory(Intent.CATEGORY_LAUNCHER);
            launchIntent.setClassName(app.packageName, app.activityName);
        }
        launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            context.startActivity(launchIntent);
            JSONObject receipt = recordReceipt(capability, app.label, true, "Opened launcher app.");
            return ToolExecutionResult.done(true, "Opened " + app.label + ".", receipt);
        } catch (RuntimeException error) {
            JSONObject receipt = recordReceipt(capability, app.label, false, "Launch failed.");
            return ToolExecutionResult.done(false, "I could not open " + app.label + ".", receipt);
        }
    }

    private ToolExecutionResult composeEmailDraft(JSONObject args) {
        Capability capability = CAPABILITIES.get("email.compose");
        String recipient = emailDraftRecipient(args);
        String subject = emailDraftSubject(args);
        String body = emailDraftBody(args);
        if (recipient.isEmpty() && subject.isEmpty() && body.isEmpty()) {
            JSONObject receipt = recordReceipt(capability, "email_draft", false, "Email recipient, subject, or body is required.");
            return ToolExecutionResult.done(false, "Email recipient, subject, or body is required.", receipt);
        }

        Intent intent = new Intent(Intent.ACTION_SENDTO, Uri.parse("mailto:"));
        if (!recipient.isEmpty()) {
            intent.putExtra(Intent.EXTRA_EMAIL, splitAddressList(recipient));
        }
        if (!subject.isEmpty()) {
            intent.putExtra(Intent.EXTRA_SUBJECT, subject);
        }
        if (!body.isEmpty()) {
            intent.putExtra(Intent.EXTRA_TEXT, body);
        }
        return openDraftIntent(
                capability,
                recipient.isEmpty() ? "email_draft" : "email:" + recipient,
                intent,
                "Opened an email draft. Review and send it in your email app.",
                "I could not open an email draft app."
        );
    }

    private ToolExecutionResult composeSmsDraft(JSONObject args) {
        Capability capability = CAPABILITIES.get("sms.compose");
        String recipient = smsDraftRecipient(args);
        String body = smsDraftBody(args);
        if (recipient.isEmpty() && body.isEmpty()) {
            JSONObject receipt = recordReceipt(capability, "sms_draft", false, "SMS recipient or message is required.");
            return ToolExecutionResult.done(false, "SMS recipient or message is required.", receipt);
        }

        Intent intent = new Intent(Intent.ACTION_SENDTO, smstoUri(recipient));
        if (!body.isEmpty()) {
            intent.putExtra("sms_body", body);
        }
        return openDraftIntent(
                capability,
                recipient.isEmpty() ? "sms_draft" : "sms:" + recipient,
                intent,
                "Opened an SMS draft. Review and send it in your messages app.",
                "I could not open an SMS draft app."
        );
    }

    private ToolExecutionResult openDraftIntent(Capability capability, String target, Intent intent, String successReply, String failureReply) {
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            context.startActivity(intent);
            JSONObject receipt = recordReceipt(capability, target, true, "Opened draft compose intent.");
            return ToolExecutionResult.done(true, successReply, receipt);
        } catch (RuntimeException error) {
            JSONObject receipt = recordReceipt(capability, target, false, "No draft compose handler.");
            return ToolExecutionResult.done(false, failureReply, receipt);
        }
    }

    private ToolExecutionResult openUrlForTool(JSONObject args) {
        Capability capability = CAPABILITIES.get("url.open");
        String rawUrl = openUrlTarget(args);
        String url = sanitizeOpenUrl(rawUrl);
        if (url.isEmpty()) {
            String reason = rawUrl.isEmpty() ? "A web URL is required." : "Only http and https links can be opened.";
            JSONObject receipt = recordReceipt(capability, rawUrl, false, reason);
            return ToolExecutionResult.done(false, reason, receipt);
        }
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            context.startActivity(intent);
            JSONObject receipt = recordReceipt(capability, url, true, "Opened URL.");
            return ToolExecutionResult.done(true, "Opened " + url + ".", receipt);
        } catch (RuntimeException error) {
            JSONObject receipt = recordReceipt(capability, url, false, "No handler for URL.");
            return ToolExecutionResult.done(false, "I could not open that link.", receipt);
        }
    }

    private ToolExecutionResult dialNumberForTool(JSONObject args) {
        Capability capability = CAPABILITIES.get("phone.dial");
        String rawNumber = dialNumberTarget(args);
        String number = normalizeDialNumber(rawNumber);
        if (number.isEmpty()) {
            String reason = rawNumber.isEmpty() ? "A phone number is required." : "That does not look like a phone number.";
            JSONObject receipt = recordReceipt(capability, rawNumber, false, reason);
            return ToolExecutionResult.done(false, reason, receipt);
        }
        // ACTION_DIAL only pre-fills the dialer; the user still presses call. No
        // CALL_PHONE permission, no auto-call. Do not change this to ACTION_CALL.
        Intent intent = new Intent(Intent.ACTION_DIAL, Uri.fromParts("tel", number, null));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            context.startActivity(intent);
            JSONObject receipt = recordReceipt(capability, number, true, "Opened dialer pre-filled with the number.");
            return ToolExecutionResult.done(true, "Opened the dialer with " + number + ". Press call to dial.", receipt);
        } catch (RuntimeException error) {
            JSONObject receipt = recordReceipt(capability, number, false, "No dialer available.");
            return ToolExecutionResult.done(false, "I could not open the dialer.", receipt);
        }
    }

    private ToolExecutionResult openContactForTool(JSONObject args) {
        Capability capability = CAPABILITIES.get("contact.open");
        String name = contactOpenName(args);
        if (name.isEmpty()) {
            JSONObject receipt = recordReceipt(capability, "", false, "Contact name is required.");
            return ToolExecutionResult.done(false, "Tell me the contact name to open.", receipt);
        }
        if (!hasContactsPermission()) {
            JSONObject receipt = recordReceipt(capability, name, false, "Contacts permission not granted.");
            return ToolExecutionResult.done(false, CONTACTS_PERMISSION_MISSING, receipt);
        }
        Uri lookupUri = findContactLookupUri(name);
        if (lookupUri == null) {
            JSONObject receipt = recordReceipt(capability, name, false, "No matching contact.");
            return ToolExecutionResult.done(false, contactNotFoundReply(name), receipt);
        }
        Intent intent = new Intent(Intent.ACTION_VIEW, lookupUri);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            context.startActivity(intent);
            JSONObject receipt = recordReceipt(capability, name, true, "Opened contact card.");
            return ToolExecutionResult.done(true, "Opened the contact card for " + name + ".", receipt);
        } catch (RuntimeException error) {
            JSONObject receipt = recordReceipt(capability, name, false, "No contacts app available.");
            return ToolExecutionResult.done(false, "I could not open the contact card.", receipt);
        }
    }

    private boolean hasContactsPermission() {
        return context.checkSelfPermission(Manifest.permission.READ_CONTACTS) == PackageManager.PERMISSION_GRANTED;
    }

    private Uri findContactLookupUri(String name) {
        Uri filterUri = Uri.withAppendedPath(ContactsContract.Contacts.CONTENT_FILTER_URI, Uri.encode(name));
        Cursor cursor = null;
        try {
            cursor = context.getContentResolver().query(
                    filterUri,
                    new String[]{ContactsContract.Contacts._ID, ContactsContract.Contacts.LOOKUP_KEY},
                    null,
                    null,
                    null
            );
            if (cursor != null && cursor.moveToFirst()) {
                long id = cursor.getLong(0);
                String lookupKey = cursor.getString(1);
                return ContactsContract.Contacts.getLookupUri(id, lookupKey);
            }
        } catch (RuntimeException error) {
            return null;
        } finally {
            if (cursor != null) {
                cursor.close();
            }
        }
        return null;
    }

    private static List<AppCandidate> matchingLauncherApps(PackageManager packageManager, String target) {
        String normalizedTarget = normalizeAppLabel(target);
        if (normalizedTarget.isEmpty()) {
            return Collections.emptyList();
        }

        List<ResolveInfo> activities = launcherActivities(packageManager);
        List<AppCandidate> exact = new ArrayList<>();
        List<AppCandidate> fuzzy = new ArrayList<>();
        for (ResolveInfo info : activities) {
            AppCandidate candidate = appCandidate(packageManager, info);
            if (candidate == null) {
                continue;
            }
            String label = candidate.label;
            String packageName = candidate.packageName;
            String normalizedLabel = normalizeAppLabel(label);
            String normalizedPackage = normalizeAppLabel(packageName);
            if (normalizedLabel.equals(normalizedTarget) || normalizedPackage.equals(normalizedTarget)) {
                exact.add(candidate);
            } else if (normalizedLabel.contains(normalizedTarget) || normalizedPackage.contains(normalizedTarget)) {
                fuzzy.add(candidate);
            }
        }
        return exact.isEmpty() ? fuzzy : exact;
    }

    private static List<String> launcherAppLabels(PackageManager packageManager) {
        Map<String, AppCandidate> byPackage = new HashMap<>();
        for (ResolveInfo info : launcherActivities(packageManager)) {
            AppCandidate candidate = appCandidate(packageManager, info);
            if (candidate != null && !byPackage.containsKey(candidate.packageName)) {
                byPackage.put(candidate.packageName, candidate);
            }
        }

        List<AppCandidate> apps = new ArrayList<>(byPackage.values());
        Collections.sort(apps, (left, right) -> {
            String leftLabel = normalizeAppLabel(left.label);
            String rightLabel = normalizeAppLabel(right.label);
            int labelCompare = leftLabel.compareTo(rightLabel);
            if (labelCompare != 0) {
                return labelCompare;
            }
            return left.packageName.compareTo(right.packageName);
        });

        List<String> labels = new ArrayList<>();
        for (AppCandidate app : apps) {
            labels.add(app.label);
        }
        return labels;
    }

    private static List<ResolveInfo> launcherActivities(PackageManager packageManager) {
        Intent launcherIntent = new Intent(Intent.ACTION_MAIN);
        launcherIntent.addCategory(Intent.CATEGORY_LAUNCHER);
        return packageManager.queryIntentActivities(launcherIntent, 0);
    }

    private static AppCandidate appCandidate(PackageManager packageManager, ResolveInfo info) {
        if (info == null || info.activityInfo == null) {
            return null;
        }
        String packageName = safe(info.activityInfo.packageName);
        String activityName = safe(info.activityInfo.name);
        if (packageName.isEmpty()) {
            return null;
        }
        CharSequence loadedLabel = info.loadLabel(packageManager);
        String label = safe(loadedLabel == null ? "" : loadedLabel.toString());
        return new AppCandidate(label.isEmpty() ? packageName : label, packageName, activityName);
    }

    static String openAppTarget(String text) {
        String trimmed = safe(text);
        String lower = trimmed.toLowerCase(Locale.US);
        String[] prefixes = {
                "/open app ",
                "/launch app ",
                "open app ",
                "launch app ",
                "start app "
        };
        for (String prefix : prefixes) {
            if (lower.startsWith(prefix)) {
                return trimmed.substring(prefix.length()).trim();
            }
        }
        return "";
    }

    static boolean isAppListCommand(String text) {
        String lower = safe(text).toLowerCase(Locale.US);
        return "/apps".equals(lower) || "/list apps".equals(lower);
    }

    static String normalizeAppLabel(String value) {
        return safe(value)
                .toLowerCase(Locale.US)
                .replaceAll("[^a-z0-9]+", " ")
                .trim();
    }

    static String formatAppListReply(List<String> labels, int requestedLimit) {
        if (labels == null || labels.isEmpty()) {
            return "No launcher apps were visible.";
        }
        int limit = boundedAppListLimit(requestedLimit);
        int count = Math.min(labels.size(), limit);
        StringBuilder builder = new StringBuilder();
        if (count < labels.size()) {
            builder.append("Installed apps (").append(count).append(" of ").append(labels.size()).append("): ");
        } else {
            builder.append("Installed apps: ");
        }
        for (int i = 0; i < count; i += 1) {
            if (i > 0) {
                builder.append(", ");
            }
            builder.append(labels.get(i));
        }
        builder.append(". Say /open app <name> to launch one.");
        return builder.toString();
    }

    static int boundedAppListLimit(int requestedLimit) {
        if (requestedLimit <= 0) {
            return DEFAULT_APP_LIST_LIMIT;
        }
        return Math.min(requestedLimit, MAX_APP_LIST_LIMIT);
    }

    static String emailDraftRecipient(JSONObject input) {
        JSONObject args = input == null ? new JSONObject() : input;
        return safe(args.optString("to", args.optString("recipient", args.optString("email", ""))));
    }

    static String emailDraftSubject(JSONObject input) {
        JSONObject args = input == null ? new JSONObject() : input;
        return safe(args.optString("subject", args.optString("title", "")));
    }

    static String emailDraftBody(JSONObject input) {
        JSONObject args = input == null ? new JSONObject() : input;
        return safe(args.optString("body", args.optString("message", args.optString("text", ""))));
    }

    static String smsDraftRecipient(JSONObject input) {
        JSONObject args = input == null ? new JSONObject() : input;
        return safe(args.optString("to", args.optString("recipient", args.optString("phone", args.optString("number", "")))));
    }

    static String smsDraftBody(JSONObject input) {
        JSONObject args = input == null ? new JSONObject() : input;
        return safe(args.optString("body", args.optString("message", args.optString("text", ""))));
    }

    static final String CONTACTS_PERMISSION_MISSING =
            "Contacts permission not granted. Open the A.G. app to grant it.";

    static String openUrlTarget(JSONObject input) {
        JSONObject args = input == null ? new JSONObject() : input;
        return safe(args.optString("url", args.optString("link", args.optString("href", ""))));
    }

    // http/https only. Returns the trimmed URL when the scheme is allowed,
    // otherwise "" so the caller rejects javascript:, file:, content:, intent:
    // and every other non-web scheme before ACTION_VIEW.
    static String sanitizeOpenUrl(String value) {
        String trimmed = safe(value);
        if (trimmed.isEmpty()) {
            return "";
        }
        int schemeEnd = trimmed.indexOf("://");
        if (schemeEnd <= 0) {
            return "";
        }
        String scheme = trimmed.substring(0, schemeEnd).toLowerCase(Locale.US);
        if (scheme.equals("http") || scheme.equals("https")) {
            return trimmed;
        }
        return "";
    }

    static String dialNumberTarget(JSONObject input) {
        JSONObject args = input == null ? new JSONObject() : input;
        return safe(args.optString("number", args.optString("phone", args.optString("tel", args.optString("to", "")))));
    }

    // Strip spaces, dashes, parens, and dots; keep a single leading +; digits
    // only otherwise. Returns "" for empty input or garbage (letters, stray
    // symbols, a lone +) so the dialer never opens on nonsense.
    static String normalizeDialNumber(String value) {
        String trimmed = safe(value);
        if (trimmed.isEmpty()) {
            return "";
        }
        boolean leadingPlus = trimmed.charAt(0) == '+';
        String body = leadingPlus ? trimmed.substring(1) : trimmed;
        StringBuilder digits = new StringBuilder();
        for (int i = 0; i < body.length(); i += 1) {
            char c = body.charAt(i);
            if (c >= '0' && c <= '9') {
                digits.append(c);
            } else if (c == ' ' || c == '-' || c == '(' || c == ')' || c == '.' || c == '\t') {
                // allowed formatting, drop it
            } else {
                // letters, a second +, or any other symbol -> reject as garbage
                return "";
            }
        }
        if (digits.length() == 0) {
            return "";
        }
        return (leadingPlus ? "+" : "") + digits;
    }

    static String contactOpenName(JSONObject input) {
        JSONObject args = input == null ? new JSONObject() : input;
        return safe(args.optString("name", args.optString("contact", args.optString("person", args.optString("query", "")))));
    }

    static String contactNotFoundReply(String name) {
        return "No contact found matching \"" + safe(name) + "\".";
    }

    static boolean isKnownTool(String tool) {
        return CAPABILITIES.containsKey(safe(tool).toLowerCase(Locale.US));
    }

    static String capabilityRisk(String tool) {
        Capability capability = CAPABILITIES.get(safe(tool).toLowerCase(Locale.US));
        return capability == null ? "" : capability.risk;
    }

    static String capabilityApproval(String tool) {
        Capability capability = CAPABILITIES.get(safe(tool).toLowerCase(Locale.US));
        return capability == null ? "" : capability.approval;
    }

    private static String[] splitAddressList(String recipients) {
        String[] raw = safe(recipients).split("[,;]");
        List<String> addresses = new ArrayList<>();
        for (String item : raw) {
            String address = safe(item);
            if (!address.isEmpty()) {
                addresses.add(address);
            }
        }
        return addresses.toArray(new String[0]);
    }

    private static Uri smstoUri(String recipient) {
        String target = safe(recipient);
        return target.isEmpty() ? Uri.parse("smsto:") : Uri.parse("smsto:" + Uri.encode(target));
    }

    // Keep this list in sync with OverlayService.androidLocalToolManifest(),
    // which advertises the same tools to the gateway cross-device hub.
    private static Map<String, Capability> createCapabilityManifest() {
        Map<String, Capability> capabilities = new HashMap<>();
        capabilities.put("screen.summary", new Capability("screen.summary", RISK_READ_ONLY, "none"));
        capabilities.put("screen.tap_text", new Capability("screen.tap_text", RISK_NAVIGATION, APPROVAL_IMPLICIT));
        capabilities.put("system.back", new Capability("system.back", RISK_NAVIGATION, APPROVAL_IMPLICIT));
        capabilities.put("system.home", new Capability("system.home", RISK_NAVIGATION, APPROVAL_IMPLICIT));
        capabilities.put("app.launch", new Capability("app.launch", RISK_NAVIGATION, APPROVAL_IMPLICIT));
        capabilities.put("app.list", new Capability("app.list", RISK_READ_ONLY, "none"));
        capabilities.put("email.compose", new Capability("email.compose", RISK_EXTERNAL_SIDE_EFFECT, APPROVAL_TARGET_APP_CONFIRMATION));
        capabilities.put("sms.compose", new Capability("sms.compose", RISK_EXTERNAL_SIDE_EFFECT, APPROVAL_TARGET_APP_CONFIRMATION));
        capabilities.put("url.open", new Capability("url.open", RISK_NAVIGATION, APPROVAL_IMPLICIT));
        capabilities.put("phone.dial", new Capability("phone.dial", RISK_EXTERNAL_SIDE_EFFECT, APPROVAL_TARGET_APP_CONFIRMATION));
        capabilities.put("contact.open", new Capability("contact.open", RISK_NAVIGATION, APPROVAL_IMPLICIT));
        capabilities.put("external.side_effect", new Capability("external.side_effect", RISK_EXTERNAL_SIDE_EFFECT, "confirm"));
        capabilities.put("sensitive.side_effect", new Capability("sensitive.side_effect", "sensitive_side_effect", "blocked"));
        return Collections.unmodifiableMap(capabilities);
    }

    private static String safe(String value) {
        return value == null ? "" : value.trim();
    }

    static final class LocalActionResult {
        final boolean handled;
        final String reply;

        private LocalActionResult(boolean handled, String reply) {
            this.handled = handled;
            this.reply = reply;
        }

        static LocalActionResult handled(String reply) {
            return new LocalActionResult(true, reply == null ? "" : reply);
        }

        static LocalActionResult notHandled() {
            return new LocalActionResult(false, "");
        }
    }

    static final class ToolExecutionResult {
        final boolean success;
        final String reply;
        final JSONObject receipt;

        private ToolExecutionResult(boolean success, String reply, JSONObject receipt) {
            this.success = success;
            this.reply = reply == null ? "" : reply;
            this.receipt = receipt;
        }

        static ToolExecutionResult done(boolean success, String reply, JSONObject receipt) {
            return new ToolExecutionResult(success, reply, receipt);
        }
    }

    private static final class Capability {
        final String tool;
        final String risk;
        final String approval;

        Capability(String tool, String risk, String approval) {
            this.tool = tool;
            this.risk = risk;
            this.approval = approval;
        }
    }

    private static final class AppCandidate {
        final String label;
        final String packageName;
        final String activityName;

        AppCandidate(String label, String packageName, String activityName) {
            this.label = label;
            this.packageName = packageName;
            this.activityName = activityName;
        }
    }
}
