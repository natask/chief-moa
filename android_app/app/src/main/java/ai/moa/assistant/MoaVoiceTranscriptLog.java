package ai.moa.assistant;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Ordered, persistent list of voice transcript rows shown on the overlay card.
 *
 * The old overlay held exactly two mutable slots (one user line, one assistant
 * line) that every new turn overwrote, so a reply vanished the moment the next
 * turn started or an auto-dismiss timer fired. This log keeps a stacked history
 * instead: each turn appends a fresh user row and a fresh assistant row.
 * Steering keeps the interrupted turn and collapses older resolved rows;
 * otherwise rows remain swipe-dismissable and silently trim to a sane bound.
 *
 * The rendering and swipe gestures live in {@link OverlayService}; this class is
 * pure Java (no Android types) so the append / trim / cascade-dismiss logic can
 * be unit tested.
 */
final class MoaVoiceTranscriptLog {

    enum Role { USER, ASSISTANT }

    static final class Entry {
        final Role role;
        String text;
        boolean finalText;
        boolean interrupted;

        Entry(Role role, String text, boolean finalText) {
            this.role = role;
            this.text = text == null ? "" : text;
            this.finalText = finalText;
        }

        boolean isUser() {
            return role == Role.USER;
        }
    }

    private final int maxEntries;
    private final List<Entry> entries = new ArrayList<>();

    // The user / assistant rows being streamed for the turn in flight. A new turn
    // clears these pointers (via startTurn) so the next partial appends a fresh
    // row instead of overwriting the previous turn's row.
    private Entry currentUser;
    private Entry currentAssistant;

    MoaVoiceTranscriptLog(int maxEntries) {
        this.maxEntries = Math.max(1, maxEntries);
    }

    List<Entry> entries() {
        return Collections.unmodifiableList(entries);
    }

    int size() {
        return entries.size();
    }

    boolean isEmpty() {
        return entries.isEmpty();
    }

    Entry get(int index) {
        return entries.get(index);
    }

    int indexOf(Entry entry) {
        return entries.indexOf(entry);
    }

    /** Begin a new turn: stop treating the prior rows as the live turn. */
    void startTurn() {
        currentUser = null;
        currentAssistant = null;
    }

    /** Mark the assistant being steered away from and discard older resolved rows. */
    boolean markSteeringBoundary() {
        boolean marked = currentAssistant != null && !currentAssistant.text.isEmpty();
        if (marked) {
            currentAssistant.interrupted = true;
        }
        for (int i = entries.size() - 1; i >= 0; i--) {
            Entry entry = entries.get(i);
            if (entry != currentUser && entry != currentAssistant) {
                entries.remove(i);
            }
        }
        return marked;
    }

    /** Set / update this turn's user row, appending it on first call. */
    Entry setUser(String text, boolean finalText) {
        String value = text == null ? "" : text;
        if (currentUser == null) {
            currentUser = new Entry(Role.USER, value, finalText);
            add(currentUser);
        } else {
            currentUser.text = value;
            currentUser.finalText = finalText;
        }
        return currentUser;
    }

    /** Set / update this turn's assistant row, appending it on first call. */
    Entry setAssistant(String text) {
        String value = text == null ? "" : text;
        if (currentAssistant == null) {
            currentAssistant = new Entry(Role.ASSISTANT, value, true);
            add(currentAssistant);
        } else {
            currentAssistant.text = value;
        }
        return currentAssistant;
    }

    String currentUserText() {
        return currentUser == null ? "" : currentUser.text;
    }

    String currentAssistantText() {
        return currentAssistant == null ? "" : currentAssistant.text;
    }

    /**
     * Dismiss the row at {@code index} and every older row (all lower indices,
     * i.e. the ones stacked above it). Returns the number of rows removed.
     */
    int dismissCascade(int index) {
        if (index < 0 || entries.isEmpty()) {
            return 0;
        }
        int upper = Math.min(index, entries.size() - 1);
        int removed = 0;
        for (int i = upper; i >= 0; i--) {
            forget(entries.remove(i));
            removed++;
        }
        return removed;
    }

    int dismissCascadeFrom(Entry entry) {
        return dismissCascade(indexOf(entry));
    }

    void clear() {
        entries.clear();
        currentUser = null;
        currentAssistant = null;
    }

    private void add(Entry entry) {
        entries.add(entry);
        while (entries.size() > maxEntries) {
            forget(entries.remove(0));
        }
    }

    private void forget(Entry entry) {
        if (entry == currentUser) {
            currentUser = null;
        }
        if (entry == currentAssistant) {
            currentAssistant = null;
        }
    }
}
