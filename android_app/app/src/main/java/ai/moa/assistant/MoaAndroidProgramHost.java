package ai.moa.assistant;

import org.json.JSONObject;

/** Narrow local host: JavaScript can reach only these Accessibility adapters. */
final class MoaAndroidProgramHost {
    interface AccessibilityAdapter {
        boolean targetMatches(MoaSurfaceProgramContract.Proposal proposal);
        JSONObject observe();
        JSONObject find(JSONObject input);
        MoaAccessibilityService.ProgramActionResult act(MoaSurfaceProgramContract.Proposal proposal, String capabilityId, JSONObject input);
    }
    private final AccessibilityAdapter accessibility;

    MoaAndroidProgramHost() { this(new PlatformAccessibilityAdapter()); }
    MoaAndroidProgramHost(AccessibilityAdapter accessibility) { this.accessibility = accessibility; }

    HostResult call(MoaSurfaceProgramContract.Proposal proposal, String capabilityId, JSONObject input) {
        if (!proposal.allowedCapabilityIds.contains(capabilityId)) {
            return HostResult.rejected("capability_not_allowed", "Capability is not in the immutable catalog snapshot.");
        }
        if (proposal.alwaysAsk.contains(MoaScriptExecutionCatalog.effectClass(capabilityId))
                || (MoaScriptExecutionCatalog.SET_TEXT.equals(capabilityId) && !"preauthorized".equals(proposal.programApproval))) {
            return HostResult.rejected("approval_required", "This capability requires fresh local approval.");
        }
        if (!accessibility.targetMatches(proposal)) {
            return HostResult.stale("The program's bound Accessibility state is stale.");
        }
        if (MoaScriptExecutionCatalog.OBSERVE.equals(capabilityId)) {
            JSONObject observation = accessibility.observe();
            return observation == null ? HostResult.rejected("accessibility_unavailable", "No Accessibility observation is available.") : HostResult.success("Observed the Android Accessibility window.", observation);
        }
        if (MoaScriptExecutionCatalog.FIND.equals(capabilityId)) {
            JSONObject result = accessibility.find(input);
            return result == null ? HostResult.stale("The requested observation is stale.") : HostResult.success("Matched Accessibility nodes.", result);
        }
        MoaAccessibilityService.ProgramActionResult action = accessibility.act(proposal, capabilityId, input);
        return new HostResult(action.success, action.status, action.code, action.summary, action.data);
    }

    private static final class PlatformAccessibilityAdapter implements AccessibilityAdapter {
        public boolean targetMatches(MoaSurfaceProgramContract.Proposal proposal) { return MoaAccessibilityService.programTargetMatches(proposal); }
        public JSONObject observe() { return MoaAccessibilityService.currentProgramObservation(); }
        public JSONObject find(JSONObject input) { return MoaAccessibilityService.findProgramNodes(input); }
        public MoaAccessibilityService.ProgramActionResult act(MoaSurfaceProgramContract.Proposal proposal, String capabilityId, JSONObject input) { return MoaAccessibilityService.executeProgramAction(proposal, capabilityId, input); }
    }

    static final class HostResult {
        final boolean ok; final String status, code, summary; final JSONObject data;
        HostResult(boolean ok, String status, String code, String summary, JSONObject data) { this.ok = ok; this.status = status; this.code = code; this.summary = summary; this.data = data; }
        static HostResult success(String summary, JSONObject data) { return new HostResult(true, "succeeded", "", summary, data); }
        static HostResult stale(String summary) { return new HostResult(false, "stale_state", "stale_state", summary, null); }
        static HostResult rejected(String code, String summary) { return new HostResult(false, "rejected", code, summary, null); }
    }
}
