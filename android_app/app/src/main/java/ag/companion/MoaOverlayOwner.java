package ag.companion;

/**
 * Process-local ownership gate for the Android overlay service.
 *
 * <p>Android normally creates one service instance per component, but the
 * overlay has several launch paths (app, assistant intent, and quick tile).
 * Keeping ownership explicit makes every path converge on the same window
 * owner and prevents a replacement instance from attaching a second orb.
 */
final class MoaOverlayOwner {
    private Object owner;

    synchronized boolean claim(Object candidate) {
        if (candidate == null) {
            return false;
        }
        if (owner == null) {
            owner = candidate;
        }
        return owner == candidate;
    }

    synchronized boolean isOwner(Object candidate) {
        return owner == candidate;
    }

    synchronized void release(Object candidate) {
        if (owner == candidate) {
            owner = null;
        }
    }
}
