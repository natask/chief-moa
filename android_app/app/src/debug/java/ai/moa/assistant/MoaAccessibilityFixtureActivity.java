package ai.moa.assistant;

import android.app.Activity;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.concurrent.atomic.AtomicInteger;

/** Debug-only, synthetic screen for isolated Accessibility adapter QA. */
public final class MoaAccessibilityFixtureActivity extends Activity {
    static final String MARKER = "MOA_SYNTHETIC_ACCESSIBILITY_FIXTURE_V1";
    static final String PRIVATE_FIXTURE_VALUE = "SYNTHETIC_PASSWORD_MUST_BE_REDACTED";
    static final AtomicInteger CLICK_COUNT = new AtomicInteger();
    static final AtomicInteger SCROLL_Y = new AtomicInteger();

    private LinearLayout semanticRoot;
    private TextView actionStatus;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        CLICK_COUNT.set(0);
        SCROLL_Y.set(0);
        semanticRoot = column();
        semanticRoot.setContentDescription(MARKER);

        TextView heading = text("Synthetic Accessibility fixture");
        if (Build.VERSION.SDK_INT >= 28) heading.setAccessibilityHeading(true);
        semanticRoot.addView(heading);

        Button action = new Button(this);
        action.setText("Synthetic action");
        action.setContentDescription("Synthetic action button");
        action.setOnClickListener(ignored -> {
            int count = CLICK_COUNT.incrementAndGet();
            actionStatus.setText("Synthetic action count " + count);
        });
        semanticRoot.addView(action);

        actionStatus = text("Synthetic action count 0");
        actionStatus.setContentDescription("Synthetic action status");
        semanticRoot.addView(actionStatus);

        Button drift = new Button(this);
        drift.setText("Introduce semantic drift");
        drift.setContentDescription("Introduce semantic drift button");
        drift.setOnClickListener(ignored -> introduceSemanticDrift());
        semanticRoot.addView(drift);

        EditText privateValue = new EditText(this);
        privateValue.setHint("Synthetic password fixture");
        privateValue.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        privateValue.setText(PRIVATE_FIXTURE_VALUE);
        semanticRoot.addView(privateValue);

        ScrollView scroll = new ScrollView(this);
        scroll.setContentDescription("Synthetic scrolling region");
        scroll.setOnScrollChangeListener((view, x, y, oldX, oldY) -> SCROLL_Y.set(y));
        LinearLayout rows = column();
        for (int index = 0; index < 60; index++) {
            rows.addView(text("Synthetic row " + index));
        }
        scroll.addView(rows, new ScrollView.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT));
        semanticRoot.addView(scroll, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                0,
                1f));
        setContentView(semanticRoot);
    }

    void introduceSemanticDrift() {
        TextView changed = text("Synthetic structure changed");
        changed.setContentDescription("Synthetic drift marker");
        semanticRoot.addView(changed, 1);
    }

    private LinearLayout column() {
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        return layout;
    }

    private TextView text(String value) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_YES);
        return view;
    }
}
