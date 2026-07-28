package ai.moa.assistant;

import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

public final class MoaSemanticNodeResolverTest {
    @Test public void resolvesEditableSiblingOfMatchedLabel() {
        Node row = new Node("row", false);
        row.add(new Node("unrelated input", true));
        Node label = row.add(new Node("Message", false));
        Node input = row.add(new Node("input", true));
        assertEquals(input, MoaSemanticNodeResolver.nearby(label, ACCESS));
    }

    @Test public void resolvesEligibleAncestorAndNearbyDescendant() {
        Node scroll = new Node("list", true);
        Node row = scroll.add(new Node("row", false));
        Node label = row.add(new Node("Latest messages", false));
        assertEquals(scroll, MoaSemanticNodeResolver.nearby(label, ACCESS));
    }

    @Test public void remainsBoundedToNearbyAncestry() {
        Node root = new Node("root", false);
        Node far = root.add(new Node("far", false));
        Node branch = far.add(new Node("branch", false));
        Node eligible = branch.add(new Node("unrelated input", true));
        Node near = root.add(new Node("near", false));
        Node middle = near.add(new Node("middle", false));
        Node row = middle.add(new Node("row", false));
        Node label = row.add(new Node("Label", false));
        assertNull(MoaSemanticNodeResolver.nearby(label, ACCESS));
        assertEquals("unrelated input", eligible.name);
    }

    private static final MoaSemanticNodeResolver.Access<Node> ACCESS =
            new MoaSemanticNodeResolver.Access<Node>() {
                @Override public Node parent(Node node) { return node.parent; }
                @Override public int childCount(Node node) { return node.children.size(); }
                @Override public Node childAt(Node node, int index) { return node.children.get(index); }
                @Override public boolean eligible(Node node) { return node.eligible; }
            };

    private static final class Node {
        final String name;
        final boolean eligible;
        final List<Node> children = new ArrayList<>();
        Node parent;

        Node(String name, boolean eligible) {
            this.name = name;
            this.eligible = eligible;
        }

        Node add(Node child) {
            child.parent = this;
            children.add(child);
            return child;
        }
    }
}
