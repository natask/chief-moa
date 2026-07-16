import assert from "node:assert/strict";

const NodeFilter = { SHOW_ELEMENT: 1, FILTER_ACCEPT: 1, FILTER_REJECT: 2 };

function element(localName, attributes = {}) {
  return {
    localName,
    getAttribute: (name) => attributes[name] ?? null,
    hasAttribute: (name) => Object.hasOwn(attributes, name),
  };
}

function documentFixture(nodes, { throwOnWalk = false, withRoot = true } = {}) {
  const state = { returned: 0 };
  const document = {
    documentElement: withRoot ? {} : null,
    createTreeWalker(_root, _kind, filter) {
      if (throwOnWalk) throw new Error("tree walker unavailable");
      let index = 0;
      return {
        nextNode() {
          while (index < nodes.length) {
            const node = nodes[index++];
            if (filter.acceptNode(node) === NodeFilter.FILTER_REJECT) continue;
            state.returned += 1;
            return node;
          }
          return null;
        },
      };
    },
  };
  return { document, state };
}

const defaultDocument = documentFixture([]).document;
globalThis.document = defaultDocument;
globalThis.location = { href: "https://example.test/default" };
globalThis.NodeFilter = NodeFilter;
globalThis.AgeeProactiveHelper = {
  detectSensitivePage: () => ({ suppressed: false, reason: "default" }),
  sanitizeSignals: (signals) => signals,
};
await import(`../extension/content-proactive-observation-runtime.js?test=${Date.now()}`);
const { createContentProactiveObservationRuntime } = globalThis.AgeeContentProactiveObservationRuntime;

const defaultRuntime = createContentProactiveObservationRuntime();
assert.ok(Object.isFrozen(defaultRuntime));
assert.equal(defaultRuntime.proactiveHelper(), globalThis.AgeeProactiveHelper);
assert.deepEqual(defaultRuntime.proactiveSensitivity(), { suppressed: false, reason: "default" });

const missingHelper = createContentProactiveObservationRuntime({
  document: defaultDocument,
  location: {},
  NodeFilter,
  getHelper: () => null,
});
assert.equal(missingHelper.proactiveHelper(), null);
assert.deepEqual(missingHelper.proactiveSensitivity(), { suppressed: true, reason: "helper_unavailable" });
assert.equal(missingHelper.collectProactiveSignals(), null);

const helper = {
  detectSensitivePage(document, location) {
    return { suppressed: location.pathname === "/login", sameDocument: document };
  },
  sanitizeSignals: (signals) => signals,
};
const overlayRoot = element("article");
const nodes = [
  overlayRoot,
  element("article"),
  element("main", { role: "MAIN" }),
  element("h1"),
  element("h2"),
  element("h3"),
  element("div", { role: "heading" }),
  element("p"),
  element("a", { href: "/details" }),
  element("a"),
  element("table"),
  element("div", { role: "table" }),
  element("div", { role: "grid" }),
  element("ul"),
  element("ol"),
  element("div", { role: "list" }),
  element("input", { type: "CHECKBOX" }),
  element("div", { role: "checkbox" }),
  element("div", { "data-task": "" }),
  element("div", { "data-todo": "" }),
  element("form"),
  element("input", { type: "text" }),
  element("input", { type: "hidden" }),
  element("textarea"),
  element("select"),
  element("div", { contenteditable: "TRUE" }),
  element("button"),
  element("div", { role: "button" }),
  element("section"),
];
const structuralDocument = documentFixture(nodes).document;
const location = { pathname: "/login" };
const runtime = createContentProactiveObservationRuntime({
  document: structuralDocument,
  location,
  NodeFilter,
  getHelper: () => helper,
  getOverlayRoot: () => overlayRoot,
});
assert.deepEqual(runtime.proactiveSensitivity(), { suppressed: true, sameDocument: structuralDocument });
assert.deepEqual(runtime.collectProactiveSignals(), {
  article_count: 2,
  heading_count: 4,
  paragraph_count: 1,
  link_count: 1,
  table_count: 3,
  list_count: 3,
  task_count: 4,
  form_count: 1,
  editable_count: 5,
  button_count: 2,
});

const noRoot = documentFixture([], { withRoot: false }).document;
assert.equal(createContentProactiveObservationRuntime({
  document: noRoot,
  NodeFilter,
  getHelper: () => helper,
}).collectProactiveSignals(), null);

const throwingDocument = documentFixture([], { throwOnWalk: true }).document;
assert.equal(createContentProactiveObservationRuntime({
  document: throwingDocument,
  NodeFilter,
  getHelper: () => helper,
}).collectProactiveSignals(), null);

const rejectingHelper = { ...helper, sanitizeSignals: () => null };
assert.equal(createContentProactiveObservationRuntime({
  document: defaultDocument,
  NodeFilter,
  getHelper: () => rejectingHelper,
}).collectProactiveSignals(), null);

const paragraphCap = documentFixture(Array.from({ length: 101 }, () => element("p"))).document;
assert.equal(createContentProactiveObservationRuntime({
  document: paragraphCap,
  NodeFilter,
  getHelper: () => helper,
}).collectProactiveSignals().paragraph_count, 100);

const saturationCycle = () => [
  element("article"),
  element("h1"),
  element("p"),
  element("a", { href: "/" }),
  element("table"),
  element("ul"),
  element("input", { type: "checkbox", role: "button" }),
  element("form"),
];
const saturatedDocument = documentFixture(Array.from({ length: 100 }, saturationCycle).flat());
assert.deepEqual(createContentProactiveObservationRuntime({
  document: saturatedDocument.document,
  NodeFilter,
  getHelper: () => helper,
}).collectProactiveSignals(), {
  article_count: 100,
  heading_count: 100,
  paragraph_count: 100,
  link_count: 100,
  table_count: 100,
  list_count: 100,
  task_count: 100,
  form_count: 100,
  editable_count: 100,
  button_count: 100,
});
assert.equal(saturatedDocument.state.returned, 800);

const visitedCap = documentFixture(Array.from({ length: 2001 }, () => element("section")));
createContentProactiveObservationRuntime({
  document: visitedCap.document,
  NodeFilter,
  getHelper: () => helper,
}).collectProactiveSignals();
assert.equal(visitedCap.state.returned, 2000);

console.log("content proactive observation runtime tests passed");
