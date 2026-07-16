package ai.moa.assistant;

/** Process-local semantic cache that can be atomically cleared with service authority. */
final class MoaScreenContextCache {
    private Snapshot snapshot = Snapshot.empty();

    synchronized void update(
            String packageName,
            String className,
            String summary,
            long updatedAtMs,
            boolean secureContent
    ) {
        snapshot = new Snapshot(packageName, className, summary, updatedAtMs, secureContent);
    }

    synchronized void clear() {
        snapshot = Snapshot.empty();
    }

    synchronized Snapshot read() {
        return snapshot;
    }

    static final class Snapshot {
        final String packageName;
        final String className;
        final String summary;
        final long updatedAtMs;
        final boolean secureContent;

        Snapshot(String packageName, String className, String summary, long updatedAtMs, boolean secureContent) {
            this.packageName = safe(packageName);
            this.className = safe(className);
            this.summary = safe(summary);
            this.updatedAtMs = updatedAtMs;
            this.secureContent = secureContent;
        }

        boolean available() {
            return !packageName.isEmpty() && updatedAtMs > 0L;
        }

        private static Snapshot empty() {
            return new Snapshot("", "", "", 0L, false);
        }

        private static String safe(String value) {
            return value == null ? "" : value;
        }
    }
}
