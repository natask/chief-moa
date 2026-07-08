"use strict";

// Integration tests each migrate a Postgres database. node:test runs test files
// concurrently, and node-pg-migrate takes a single migration lock, so two files
// pointed at the same database collide ("Another migration is already running").
// Give each integration file its own database, created fresh from the base
// DATABASE_URL, so they never race and never see each other's rows.

const { Client } = require("pg");

function baseUrl() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required for isolated integration databases");
  return new URL(url);
}

function adminClient() {
  const admin = baseUrl();
  admin.pathname = "/postgres";
  return new Client({ connectionString: admin.toString() });
}

// Create <base>_<label> fresh (dropping any prior copy) and return a URL to it.
async function createIsolatedDatabase(label) {
  const parsed = baseUrl();
  const safeLabel = String(label).replace(/[^a-z0-9_]/gi, "_").toLowerCase();
  const baseName = parsed.pathname.replace(/^\//, "") || "postgres";
  const dbName = `${baseName}_${safeLabel}`.slice(0, 63);

  const admin = adminClient();
  await admin.connect();
  try {
    await admin.query(`drop database if exists "${dbName}" with (force)`);
    await admin.query(`create database "${dbName}"`);
  } finally {
    await admin.end();
  }

  const dbUrl = baseUrl();
  dbUrl.pathname = `/${dbName}`;
  return { databaseUrl: dbUrl.toString(), dbName };
}

async function dropIsolatedDatabase(dbName) {
  if (!dbName) return;
  const admin = adminClient();
  await admin.connect();
  try {
    await admin.query(`drop database if exists "${dbName}" with (force)`);
  } finally {
    await admin.end();
  }
}

module.exports = { createIsolatedDatabase, dropIsolatedDatabase };
