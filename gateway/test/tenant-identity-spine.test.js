"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const migration = require("../migrations/1783296000004_tenant-identity-spine");

function migrationSql(direction) {
  const statements = [];
  migration[direction]({ sql: (statement) => statements.push(statement) });
  return statements.join("\n");
}

test("tenant identity migration is additive and seeds the legacy owner", () => {
  const sql = migrationSql("up");

  assert.match(sql, /create table if not exists tenants/i);
  assert.match(sql, /create table if not exists tenant_memberships/i);
  assert.match(sql, /values \('owner','personal','Owner'\)/i);
  assert.match(sql, /values \('owner','owner','owner','active'\)/i);
  assert.doesNotMatch(sql, /\bdrop table\b/i);
  assert.doesNotMatch(sql, /\balter column\b/i);
});

test("tenant identity migration binds auth identities and both principal axes", () => {
  const sql = migrationSql("up");

  assert.match(sql, /unique index if not exists identities_auth_user_id_unique/i);
  assert.match(sql, /where auth_user_id is not null/i);
  assert.match(sql, /alter table tenants force row level security/i);
  assert.match(sql, /alter table tenant_memberships force row level security/i);
  assert.match(sql, /current_setting\('moa\.tenant_id', true\)/i);
  assert.match(sql, /current_setting\('moa\.user_id', true\)/i);
  assert.match(sql, /membership\.status = 'active'/i);
});

test("tenant identity rollback removes only this migration's objects", () => {
  const sql = migrationSql("down");

  assert.match(sql, /drop index if exists identities_auth_user_id_unique/i);
  assert.match(sql, /drop table if exists tenant_memberships cascade/i);
  assert.match(sql, /drop table if exists tenants cascade/i);
  assert.doesNotMatch(sql, /drop table if exists (?:users|identities)/i);
});
