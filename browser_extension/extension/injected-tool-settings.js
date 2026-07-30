import { createBrowserInjectedToolRuntime } from "./browser-injected-tool-runtime.js";

const editor = document.getElementById("injectedToolDefinition");
const saveButton = document.getElementById("saveInjectedTool");
const removeButton = document.getElementById("removeInjectedTool");
const picker = document.getElementById("injectedToolList");
const status = document.getElementById("injectedToolStatus");
const runtime = createBrowserInjectedToolRuntime();

function exampleDefinition() {
  return {
    schema: "moa.browser-injected-tool.v1",
    name: "extract_prices",
    description: "Extract visible product prices from the current page.",
    effect: "read",
    matches: ["https://example.com/*"],
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
    source: "async (input) => ({ prices: [...document.querySelectorAll('[class*=price]')].slice(0, 50).map((node) => node.textContent.trim()) })",
    enabled: true,
  };
}

function show(message, ok = true) {
  status.textContent = message;
  status.style.color = ok ? "#35a35a" : "#c0392b";
}

async function refresh(selected = "") {
  const tools = await runtime.list();
  picker.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = tools.length ? "Choose an installed tool" : "No installed tools";
  picker.appendChild(placeholder);
  for (const tool of tools) {
    const option = document.createElement("option");
    option.value = tool.name;
    option.textContent = `${tool.tool} · ${tool.effect}`;
    option.selected = tool.name === selected;
    picker.appendChild(option);
  }
  removeButton.disabled = !picker.value;
}

picker.addEventListener("change", async () => {
  const tool = (await runtime.list()).find((candidate) => candidate.name === picker.value);
  if (tool) editor.value = JSON.stringify(tool, null, 2);
  removeButton.disabled = !tool;
});

saveButton.addEventListener("click", async () => {
  saveButton.disabled = true;
  try {
    const saved = await runtime.save(JSON.parse(editor.value));
    editor.value = JSON.stringify(saved, null, 2);
    await refresh(saved.name);
    show(`Saved ${saved.tool}. Its exact source and URL scope are now inspectable here.`);
  } catch (error) {
    show(`Could not save tool: ${String(error?.message || error)}`, false);
  } finally {
    saveButton.disabled = false;
  }
});

removeButton.addEventListener("click", async () => {
  if (!picker.value) return;
  const name = picker.value;
  await runtime.remove(name);
  editor.value = JSON.stringify(exampleDefinition(), null, 2);
  await refresh();
  show(`Removed browser.injected.${name}.`);
});

editor.value = JSON.stringify(exampleDefinition(), null, 2);
refresh().catch((error) => show(String(error?.message || error), false));
