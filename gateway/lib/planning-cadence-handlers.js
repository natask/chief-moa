"use strict";

// HTTP surface over lib/planning-cadence.js. Mirrors the shape of
// lib/intent-plane-handlers.js: thin routing, no business logic.

function createPlanningCadenceHandlers({ plane, readJsonBody, sendJson, cleanError }) {
  async function route(request, response, url) {
    try {
      if (request.method === "POST" && url.pathname === "/v1/planning-cadence/plans") {
        sendJson(response, 201, { plan: await plane.createPlan(await readJsonBody(request)) });
        return true;
      }
      if (request.method === "GET" && url.pathname === "/v1/planning-cadence/plans") {
        const horizon = url.searchParams.get("horizon") || "";
        const periodKey = url.searchParams.get("period_key") || "";
        if (horizon && periodKey) {
          sendJson(response, 200, { plan: await plane.getPlan(horizon, periodKey) });
        } else {
          sendJson(response, 200, await plane.listPlans({
            horizon, limit: url.searchParams.get("limit") || undefined, offset: url.searchParams.get("offset") || undefined,
          }));
        }
        return true;
      }
      if (request.method === "POST" && url.pathname === "/v1/planning-cadence/reviews") {
        sendJson(response, 201, { review: await plane.createReview(await readJsonBody(request)) });
        return true;
      }
      if (request.method === "GET" && url.pathname === "/v1/planning-cadence/reviews") {
        const horizon = url.searchParams.get("horizon") || "";
        const periodKey = url.searchParams.get("period_key") || "";
        if (horizon && periodKey) {
          sendJson(response, 200, { review: await plane.getReview(horizon, periodKey) });
        } else {
          sendJson(response, 200, await plane.listReviews({
            horizon, limit: url.searchParams.get("limit") || undefined, offset: url.searchParams.get("offset") || undefined,
          }));
        }
        return true;
      }
      if (request.method === "GET" && url.pathname === "/v1/planning-cadence/rollup") {
        const horizon = url.searchParams.get("horizon") || "";
        const periodKey = url.searchParams.get("period_key") || "";
        if (!horizon || !periodKey) {
          sendJson(response, 400, { error: "horizon and period_key are required" });
          return true;
        }
        sendJson(response, 200, await plane.rollup(horizon, periodKey));
        return true;
      }
    } catch (error) {
      sendJson(response, 400, { error: cleanError(error) });
      return true;
    }
    sendJson(response, 404, { error: "unknown planning-cadence endpoint" });
    return true;
  }
  return { routePlanningCadence: route };
}

module.exports = { createPlanningCadenceHandlers };
