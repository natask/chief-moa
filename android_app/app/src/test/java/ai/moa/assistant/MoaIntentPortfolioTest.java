package ai.moa.assistant;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public final class MoaIntentPortfolioTest {
    @Test
    public void parsesBoundedLifecycleProjection() throws Exception {
        JSONObject payload = new JSONObject()
                .put("items", new JSONArray()
                        .put(new JSONObject()
                                .put("intent_id", "intent_one")
                                .put("normalized_objective", "Ship intent management")
                                .put("lifecycle_state", "active")
                                .put("next_step", "Verify Android")
                                .put("blockers", new JSONArray().put("phone QA"))
                                .put("run_refs", new JSONArray().put("run_1"))))
                .put("truncation", new JSONObject().put("truncated", true));

        MoaIntentPortfolio portfolio = MoaIntentPortfolio.from(payload);

        assertEquals(1, portfolio.items.size());
        assertEquals(1, portfolio.activeCount());
        assertTrue(portfolio.truncated);
        assertEquals("ACTIVE · 1 blocker · 1 run", portfolio.items.get(0).metadataLine());
        assertEquals("Verify Android", portfolio.items.get(0).nextStep);
    }

    @Test
    public void ignoresMalformedRowsAndUsesStatementFallback() throws Exception {
        JSONObject payload = new JSONObject().put("items", new JSONArray()
                .put("not an object")
                .put(new JSONObject().put("statement", "missing id"))
                .put(new JSONObject().put("intent_id", "intent_two").put("statement", "Research DBOS")));

        MoaIntentPortfolio portfolio = MoaIntentPortfolio.from(payload);

        assertEquals(1, portfolio.items.size());
        assertEquals("Research DBOS", portfolio.items.get(0).objective);
        assertFalse(portfolio.truncated);
    }
}
