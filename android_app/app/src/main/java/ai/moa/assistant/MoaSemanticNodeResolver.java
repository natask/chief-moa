package ai.moa.assistant;

import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.Set;

/** Bounded nearby-node resolution for semantic Accessibility targets. */
final class MoaSemanticNodeResolver {
    private static final int MAX_ANCESTOR_HOPS = 2;
    private static final int MAX_DESCENDANT_DEPTH = 3;
    private static final int MAX_VISITED_NODES = 96;

    interface Access<T> {
        T parent(T node);
        int childCount(T node);
        T childAt(T node, int index);
        boolean eligible(T node);
    }

    static <T> T nearby(T match, Access<T> access) {
        if (match == null || access == null) return null;
        Set<T> visited = Collections.newSetFromMap(new IdentityHashMap<>());
        int[] budget = {MAX_VISITED_NODES};
        T found = descendants(match, access, visited, budget, 0);
        if (found != null) return found;
        T scope = match;
        for (int hop = 1; scope != null && hop <= MAX_ANCESTOR_HOPS; hop += 1) {
            T parent = access.parent(scope);
            if (parent == null || budget[0] <= 0) return null;
            if (visited.add(parent)) {
                budget[0] -= 1;
                if (access.eligible(parent)) return parent;
            }
            int count = Math.min(Math.max(0, access.childCount(parent)), 64);
            int scopeIndex = -1;
            for (int index = 0; index < count; index += 1) {
                if (access.childAt(parent, index) == scope) {
                    scopeIndex = index;
                    break;
                }
            }
            for (int distance = 1; distance < count; distance += 1) {
                int after = scopeIndex + distance;
                int before = scopeIndex - distance;
                if (scopeIndex < 0) after = distance - 1;
                if (after >= 0 && after < count) {
                    found = descendants(access.childAt(parent, after), access,
                            visited, budget, 0);
                    if (found != null) return found;
                }
                if (scopeIndex >= 0 && before >= 0) {
                    found = descendants(access.childAt(parent, before), access,
                            visited, budget, 0);
                    if (found != null) return found;
                }
            }
            scope = parent;
        }
        return null;
    }

    private static <T> T descendants(
            T node, Access<T> access, Set<T> visited, int[] budget, int depth) {
        if (node == null || depth > MAX_DESCENDANT_DEPTH || budget[0] <= 0
                || !visited.add(node)) return null;
        budget[0] -= 1;
        if (access.eligible(node)) return node;
        int childCount = Math.min(Math.max(0, access.childCount(node)), 64);
        for (int index = 0; index < childCount; index += 1) {
            T found = descendants(
                    access.childAt(node, index), access, visited, budget, depth + 1);
            if (found != null) return found;
        }
        return null;
    }

    private MoaSemanticNodeResolver() {}
}
