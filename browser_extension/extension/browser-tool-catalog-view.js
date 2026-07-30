function createBrowserToolCatalogView({ request, list, status, refreshButton }) {
  async function refresh() {
    refreshButton.disabled = true;
    status.textContent = "Reading browser capabilities…";
    try {
      const response = await request({ cmd: "browserTools" });
      if (!response?.ok) throw new Error(response?.error || "Browser tools are unavailable.");
      list.replaceChildren();
      for (const tool of response.tools || []) {
        const item = document.createElement("li");
        const name = document.createElement("code");
        name.textContent = tool.tool;
        const detail = document.createElement("span");
        detail.textContent = `${tool.kind} · ${tool.risk} · ${tool.approval}`;
        item.append(name, detail);
        list.appendChild(item);
      }
      status.textContent = response.capability === "available"
        ? `${(response.tools || []).length} browser tools available; installed JavaScript tools are enabled.`
        : `${(response.tools || []).length} packaged tools available; installed JavaScript tools are ${response.capability}.`;
    } catch (error) {
      status.textContent = String(error?.message || error);
    } finally {
      refreshButton.disabled = false;
    }
  }
  refreshButton.addEventListener("click", refresh);
  return Object.freeze({ refresh });
}

export { createBrowserToolCatalogView };
