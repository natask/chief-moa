package ai.moa.assistant;

import android.content.Context;
import android.view.View;
import android.widget.ScrollView;

/**
 * Scroll container whose content can shrink within, but never exceed, a fixed
 * overlay viewport.
 */
final class MoaCappedScrollView extends ScrollView {
    private final int maxHeight;

    MoaCappedScrollView(Context context, int maxHeight) {
        super(context);
        this.maxHeight = maxHeight;
    }

    @Override
    protected void onMeasure(int widthMeasureSpec, int heightMeasureSpec) {
        int parentMode = View.MeasureSpec.getMode(heightMeasureSpec);
        int parentSize = View.MeasureSpec.getSize(heightMeasureSpec);
        int cap = parentMode == View.MeasureSpec.UNSPECIFIED || parentSize <= 0
                ? maxHeight
                : Math.min(parentSize, maxHeight);
        int cappedHeight = View.MeasureSpec.makeMeasureSpec(cap, View.MeasureSpec.AT_MOST);
        super.onMeasure(widthMeasureSpec, cappedHeight);
    }
}
