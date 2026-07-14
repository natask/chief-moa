import assert from "node:assert/strict";
import {
  browserContextDescriptor,
  browserSessionExecutionAdapters,
} from "../extension/browser-context-adapter.js";

const capturedAt = "2026-07-13T12:00:00.000Z";
const descriptor = browserContextDescriptor({
  url: "https://mail.example.com/inbox/private-thread?token=secret#message-7",
  title: "  Inbox\n— Example Mail  ",
  incognito: false,
}, { capturedAt });

assert.equal(descriptor.availability, "available");
assert.equal(descriptor.application.id, "mail.example.com");
assert.equal(descriptor.application.origin, "https://mail.example.com");
assert.equal(descriptor.page.title, "Inbox — Example Mail");
assert.equal(descriptor.page.location_scope, "origin_only");
assert.equal(descriptor.captured_at, capturedAt);
const serialized = JSON.stringify(descriptor);
assert.equal(serialized.includes("private-thread"), false);
assert.equal(serialized.includes("token=secret"), false);
assert.equal(serialized.includes("message-7"), false);

const [adapter] = browserSessionExecutionAdapters(descriptor);
assert.equal(adapter.adapter, "browser_session");
assert.equal(adapter.status, "available");
assert.equal(adapter.credential_source, "existing_browser_session");
assert.equal(adapter.authentication_state, "not_inspected");
assert.equal(adapter.context_binding.application_id, "mail.example.com");
assert.ok(adapter.modes.includes("bounded_dom_actions"));
assert.ok(adapter.constraints.includes("no_cookie_export"));

const incognito = browserContextDescriptor({
  url: "https://private.example/secret?q=hidden",
  title: "Private title",
  incognito: true,
}, { capturedAt });
assert.equal(incognito.availability, "unavailable");
assert.equal(incognito.reason, "incognito_withheld");
assert.equal(JSON.stringify(incognito).includes("private.example"), false);
assert.equal(browserSessionExecutionAdapters(incognito)[0].status, "unavailable");

const restricted = browserContextDescriptor({
  url: "chrome://settings/passwords",
  title: "Passwords",
}, { capturedAt });
assert.equal(restricted.availability, "unavailable");
assert.equal(restricted.reason, "restricted_page");
assert.equal(JSON.stringify(restricted).includes("Passwords"), false);

const absent = browserContextDescriptor(null, { capturedAt });
assert.equal(absent.reason, "no_active_tab");

const longTitle = browserContextDescriptor({
  url: "http://example.com/path",
  title: "x".repeat(500),
}, { capturedAt });
assert.equal(longTitle.page.title.length, 160);

console.log("browser context adapter tests passed");
