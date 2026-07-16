package ai.moa.assistant;

import org.json.JSONObject;

/** Narrow local host: JavaScript can reach only these Accessibility adapters. */
final class MoaAndroidProgramHost {
    interface AccessibilityAdapter {
        boolean bindingMatches(MoaSurfaceProgramContract.Proposal proposal);
        JSONObject observe(MoaSurfaceProgramContract.Proposal proposal);
        JSONObject find(MoaSurfaceProgramContract.Proposal proposal, JSONObject input);
        MoaAccessibilityProgramAdapter.ProgramActionResult act(MoaSurfaceProgramContract.Proposal proposal, String capabilityId, JSONObject input);
    }
    private final AccessibilityAdapter accessibility;

    MoaAndroidProgramHost() { this(new PlatformAccessibilityAdapter()); }
    MoaAndroidProgramHost(AccessibilityAdapter accessibility) { this.accessibility = accessibility; }

    HostResult call(MoaSurfaceProgramContract.Proposal proposal, String capabilityId, JSONObject input) {
        if (!proposal.allowedCapabilityIds.contains(capabilityId)) {
            return HostResult.rejected("capability_not_allowed", "Capability is not in the immutable catalog snapshot.");
        }
        if (!validInput(capabilityId, input)) return HostResult.rejected("invalid_input", "Capability input did not match its closed schema.");
        if (proposal.alwaysAsk.contains(MoaScriptExecutionCatalog.effectClass(capabilityId))
                || (MoaScriptExecutionCatalog.isMutation(capabilityId) && "local_policy".equals(proposal.programApproval))) {
            return HostResult.rejected("approval_required", "This capability requires fresh local approval.");
        }
        if (!accessibility.bindingMatches(proposal)) {
            return HostResult.stale("The program's bound Accessibility state is stale.");
        }
        if (MoaScriptExecutionCatalog.OBSERVE.equals(capabilityId)) {
            JSONObject observation = accessibility.observe(proposal);
            return observation == null ? HostResult.rejected("accessibility_unavailable", "No Accessibility observation is available.") : HostResult.success("Observed the Android Accessibility window.", observation);
        }
        if (MoaScriptExecutionCatalog.FIND.equals(capabilityId)) {
            JSONObject result = accessibility.find(proposal, input);
            return result == null ? HostResult.stale("The requested observation is stale.") : HostResult.success("Matched Accessibility nodes.", result);
        }
        MoaAccessibilityProgramAdapter.ProgramActionResult action = accessibility.act(proposal, capabilityId, input);
        return new HostResult(action.success, action.status, action.code, action.summary, action.data, action.postStateSha256);
    }

    private static final class PlatformAccessibilityAdapter implements AccessibilityAdapter {
        public boolean bindingMatches(MoaSurfaceProgramContract.Proposal proposal) { return MoaAccessibilityProgramAdapter.bindingMatches(proposal); }
        public JSONObject observe(MoaSurfaceProgramContract.Proposal proposal) { return MoaAccessibilityProgramAdapter.boundObservation(proposal); }
        public JSONObject find(MoaSurfaceProgramContract.Proposal proposal, JSONObject input) { return MoaAccessibilityProgramAdapter.bindingMatches(proposal) ? MoaAccessibilityProgramAdapter.find(input) : null; }
        public MoaAccessibilityProgramAdapter.ProgramActionResult act(MoaSurfaceProgramContract.Proposal proposal, String capabilityId, JSONObject input) { return MoaAccessibilityProgramAdapter.execute(proposal, capabilityId, input); }
    }

    private static boolean validInput(String capability, JSONObject input) {
        java.util.Set<String> keys = new java.util.HashSet<>(); java.util.Iterator<String> iterator = input.keys(); while (iterator.hasNext()) keys.add(iterator.next());
        if (MoaScriptExecutionCatalog.OBSERVE.equals(capability) || MoaScriptExecutionCatalog.BACK.equals(capability) || MoaScriptExecutionCatalog.HOME.equals(capability)) return keys.isEmpty();
        java.util.Set<String> required = new java.util.HashSet<>(java.util.Arrays.asList("observation_id", "observation_digest", "node_id"));
        if (MoaScriptExecutionCatalog.FIND.equals(capability)) required = new java.util.HashSet<>(java.util.Arrays.asList("observation_id", "observation_digest", "query"));
        else if (MoaScriptExecutionCatalog.SCROLL.equals(capability)) required.add("direction");
        if (!keys.equals(required)) return false;
        for (String key : required) if (!(input.opt(key) instanceof String) || input.optString(key).isEmpty()) return false;
        if (MoaScriptExecutionCatalog.SCROLL.equals(capability) && !"forward".equals(input.optString("direction")) && !"backward".equals(input.optString("direction"))) return false;
        return true;
    }

    static final class HostResult {
        final boolean ok; final String status, code, summary; final JSONObject data; final String postStateSha256;
        HostResult(boolean ok, String status, String code, String summary, JSONObject data, String postStateSha256) { this.ok = ok; this.status = status; this.code = code; this.summary = summary; this.data = data; this.postStateSha256 = postStateSha256; }
        static HostResult success(String summary, JSONObject data) { return new HostResult(true, "succeeded", "", summary, data, null); }
        static HostResult stale(String summary) { return new HostResult(false, "stale_state", "stale_state", summary, null, null); }
        static HostResult rejected(String code, String summary) { return new HostResult(false, "rejected", code, summary, null, null); }
        boolean isAuthorityDenial() {
            return "approval_required".equals(code) || "policy_denied".equals(code)
                    || "capability_not_allowed".equals(code);
        }
    }
}
