package ag.companion;

import java.util.LinkedHashSet;
import java.util.Set;

/** Serializes claimed device work and makes terminal receipts request-idempotent. */
final class MoaToolRequestGate {
    private static final int MAX_TERMINAL_IDS = 256;
    private final Set<String> terminal = new LinkedHashSet<>();
    private String active = "";

    synchronized boolean start(String requestId) {
        String id = safe(requestId);
        if (id.isEmpty() || terminal.contains(id)) return false;
        if (!active.isEmpty()) return false;
        active = id;
        return true;
    }

    synchronized boolean finish(String requestId) {
        String id = safe(requestId);
        if (id.isEmpty() || terminal.contains(id) || !id.equals(active)) return false;
        terminal.add(id);
        active = "";
        while (terminal.size() > MAX_TERMINAL_IDS) {
            terminal.remove(terminal.iterator().next());
        }
        return true;
    }

    synchronized String active() {
        return active;
    }

    private static String safe(String value) {
        return value == null ? "" : value.trim();
    }
}
