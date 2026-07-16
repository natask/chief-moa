package ai.moa.assistant;

import android.content.Context;
import android.view.KeyEvent;
import android.widget.EditText;

// Composer input that reports Back-while-IME-showing. On API 26-29 there is no
// IME-visibility inset signal, and when the user presses Back the IME consumes
// the key to dismiss itself before the app sees it — except through
// onKeyPreIme, which fires on the IME target first. That callback is the
// keyboard fade guard's dismissal signal on those API levels. The event is
// never consumed here, so the IME still hides exactly as before.
final class MoaComposerEditText extends EditText {
    private Runnable imeBackListener;

    MoaComposerEditText(Context context) {
        super(context);
    }

    void setImeBackListener(Runnable listener) {
        imeBackListener = listener;
    }

    @Override
    public boolean onKeyPreIme(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK
                && event.getAction() == KeyEvent.ACTION_UP
                && imeBackListener != null) {
            imeBackListener.run();
        }
        return super.onKeyPreIme(keyCode, event);
    }
}
