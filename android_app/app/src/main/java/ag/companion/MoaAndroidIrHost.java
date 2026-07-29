package ag.companion;

import org.json.JSONObject;

/** The only authority available to a moa_android_ir_v1 program. */
interface MoaAndroidIrHost {
    Object call(String capability, JSONObject arguments) throws Exception;

    void waitMillis(long millis) throws Exception;

    void checkpoint(String name) throws Exception;

    long monotonicTimeMillis();
}
