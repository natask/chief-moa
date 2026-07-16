package ai.moa.assistant;

import android.inputmethodservice.InputMethodService;
import android.view.Gravity;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import android.view.inputmethod.InputMethodManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * Opt-in local IME safety MVP. Production microphone/STT transport is intentionally absent;
 * the fixed local candidate proves editor gating and exact InputConnection insertion.
 */
public final class MoaInputMethodService extends InputMethodService {
    static final String LOCAL_QA_CANDIDATE = "Moa IME local insertion test.";

    private final MoaEditorSessionBinding binding = new MoaEditorSessionBinding();
    private MoaEditorSessionBinding.SessionToken editorSession;
    private TextView statusView;
    private TextView candidateView;
    private Button loadCandidateButton;
    private Button insertButton;
    private Button cancelButton;

    @Override
    public View onCreateInputView() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(16), dp(12), dp(16), dp(12));
        root.setBackgroundColor(MoaColors.SURFACE_0);

        statusView = text("Local insertion QA · no audio or network", MoaColors.MUTED, 13);
        root.addView(statusView);

        candidateView = text("", MoaColors.PAPER, 17);
        candidateView.setPadding(0, dp(12), 0, dp(8));
        root.addView(candidateView);

        LinearLayout actions = new LinearLayout(this);
        actions.setGravity(Gravity.CENTER_VERTICAL);
        root.addView(actions);

        loadCandidateButton = button("Load QA text");
        loadCandidateButton.setOnClickListener(view -> loadLocalCandidate());
        actions.addView(loadCandidateButton, weightedButtonParams());

        insertButton = button("Insert");
        insertButton.setOnClickListener(view -> commitCandidate());
        actions.addView(insertButton, weightedButtonParams());

        cancelButton = button("Cancel");
        cancelButton.setOnClickListener(view -> {
            binding.clearCandidate();
            renderState("Candidate cleared");
        });
        actions.addView(cancelButton, weightedButtonParams());

        Button nextKeyboard = button("Next keyboard");
        nextKeyboard.setOnClickListener(view -> switchKeyboard());
        root.addView(nextKeyboard, fullButtonParams());

        renderState(null);
        return root;
    }

    @Override
    public void onStartInput(EditorInfo attribute, boolean restarting) {
        super.onStartInput(attribute, restarting);
        editorSession = binding.beginEditor(MoaEditorSensitivityPolicy.EditorIdentity.from(attribute));
        renderState(null);
    }

    @Override
    public void onFinishInput() {
        binding.finishEditor();
        editorSession = null;
        renderState(null);
        super.onFinishInput();
    }

    @Override
    public boolean onEvaluateFullscreenMode() {
        return false;
    }

    private void loadLocalCandidate() {
        MoaEditorSessionBinding.Rejection rejection =
                binding.stageCandidate(editorSession, LOCAL_QA_CANDIDATE);
        renderState(rejection == MoaEditorSessionBinding.Rejection.NONE
                ? "Local candidate ready"
                : rejectionMessage(rejection));
    }

    private void commitCandidate() {
        MoaEditorSensitivityPolicy.EditorIdentity currentEditor =
                MoaEditorSensitivityPolicy.EditorIdentity.from(getCurrentInputEditorInfo());
        MoaEditorSessionBinding.CommitDecision decision =
                binding.authorizeCommit(editorSession, currentEditor);
        if (!decision.allowed) {
            renderState(rejectionMessage(decision.rejection));
            return;
        }
        InputConnection connection = getCurrentInputConnection();
        if (connection == null) {
            renderState("Editor connection unavailable");
            return;
        }
        boolean committed = connection.commitText(decision.exactText, 1);
        if (committed) {
            binding.clearCandidate();
            renderState("Inserted exactly; nothing was submitted");
        } else {
            renderState("Editor refused insertion");
        }
    }

    private void switchKeyboard() {
        if (!switchToNextInputMethod(false)) {
            InputMethodManager manager = getSystemService(InputMethodManager.class);
            if (manager != null) {
                manager.showInputMethodPicker();
            }
        }
    }

    private void renderState(String message) {
        if (statusView == null || candidateView == null) {
            return;
        }
        boolean sensitive = binding.isSensitive(editorSession);
        String candidate = binding.visibleCandidate(editorSession);
        if (sensitive) {
            statusView.setText("Unavailable in password, private, or unsupported fields");
            candidateView.setText("");
        } else {
            statusView.setText(message == null
                    ? "Local insertion QA · no audio or network"
                    : message);
            candidateView.setText(candidate == null ? "No candidate staged" : candidate);
        }
        if (loadCandidateButton != null) {
            loadCandidateButton.setEnabled(!sensitive);
        }
        if (insertButton != null) {
            insertButton.setEnabled(!sensitive && candidate != null);
        }
        if (cancelButton != null) {
            cancelButton.setEnabled(!sensitive && candidate != null);
        }
    }

    private String rejectionMessage(MoaEditorSessionBinding.Rejection rejection) {
        switch (rejection) {
            case SENSITIVE_EDITOR:
                return "Sensitive editor: insertion blocked";
            case EMPTY_CANDIDATE:
                return "Candidate is empty";
            case STALE_EDITOR:
                return "Editor changed: stage the candidate again";
            case NO_CANDIDATE:
                return "No candidate staged";
            case NO_ACTIVE_EDITOR:
                return "No active editor";
            default:
                return "Insertion unavailable";
        }
    }

    private TextView text(String value, int color, int sp) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextColor(color);
        view.setTextSize(sp);
        return view;
    }

    private Button button(String value) {
        Button button = new Button(this);
        button.setAllCaps(false);
        button.setText(value);
        button.setTextColor(MoaColors.PAPER);
        button.setBackground(MoaDrawables.rounded(0x14FFFFFF, dp(12), MoaColors.RAISED_BORDER, dp(1)));
        return button;
    }

    private LinearLayout.LayoutParams weightedButtonParams() {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, dp(52), 1f);
        params.setMarginEnd(dp(6));
        return params;
    }

    private LinearLayout.LayoutParams fullButtonParams() {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                dp(48)
        );
        params.topMargin = dp(8);
        return params;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
