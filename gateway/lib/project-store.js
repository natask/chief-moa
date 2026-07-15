"use strict";

const fs = require("node:fs");

function createProjectStore(options = {}) {
  const { filePath, sanitizeId, resolveWorkingDir, sanitizeHarness, randomId } = options;
  const defaultHarness = options.defaultHarness || "echo";
  const now = typeof options.now === "function" ? options.now : () => new Date().toISOString();

  function list() {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }

  function find(id) {
    const safe = sanitizeId(id);
    return list().find((project) => project.id === safe) || null;
  }

  function write(projects) {
    fs.writeFileSync(filePath, JSON.stringify(projects, null, 2));
  }

  function create(body = {}) {
    const name = String(body.name || "").trim().slice(0, 120);
    if (!name) throw new Error("name is required");
    const projects = list();
    const timestamp = now();
    const project = {
      id: randomId("proj"),
      name,
      working_dir: resolveWorkingDir(body.working_dir || body.cwd || ""),
      default_harness: sanitizeHarness(body.default_harness || defaultHarness),
      brief: sanitizeProjectBrief(body.brief || body),
      created_at: timestamp,
      updated_at: timestamp,
    };
    projects.push(project);
    write(projects);
    return project;
  }

  function update(id, body = {}) {
    const safeId = sanitizeId(id);
    const projects = list();
    const index = projects.findIndex((project) => project.id === safeId);
    if (index < 0) return null;
    const previous = projects[index];
    const incoming = body && typeof body.brief === "object" ? body.brief : body;
    const brief = sanitizeProjectBrief({
      ...(plainObject(previous.brief)),
      ...(plainObject(incoming)),
    });
    const project = { ...previous, brief, updated_at: now() };
    projects[index] = project;
    write(projects);
    return project;
  }

  return Object.freeze({ list, find, create, update });
}

function sanitizeProjectBrief(value) {
  const input = plainObject(value);
  return {
    problem: clean(input.problem, 4000),
    desired_outcome: clean(input.desired_outcome || input.outcome, 4000),
    current_state: clean(input.current_state || input.state, 12000),
    next_step: clean(input.next_step, 4000),
  };
}

function promptWithProjectBrief(prompt, project) {
  const brief = sanitizeProjectBrief(project?.brief);
  const fields = [
    ["Problem", brief.problem], ["Desired outcome", brief.desired_outcome],
    ["Current state", brief.current_state], ["Next viable step", brief.next_step],
  ].filter(([, value]) => value);
  if (!fields.length) return prompt;
  return [
    "User instruction:", prompt, "", `Durable project brief (${project.name || project.id}):`,
    ...fields.map(([label, value]) => `${label}: ${value}`), "",
    "Use the brief as project context. Advance the user instruction and leave durable evidence; do not manage or narrate agent identities.",
  ].join("\n");
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function clean(value, max) {
  return String(value || "").trim().slice(0, max);
}

module.exports = { createProjectStore, sanitizeProjectBrief, promptWithProjectBrief };
