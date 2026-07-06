const fs = require("node:fs");
const path = require("node:path");

exports.up = (pgm) => {
  const sql = fs.readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8");
  pgm.sql(sql);
};

exports.down = (pgm) => {
  // schema.sql is all CREATE ... IF NOT EXISTS; drop the tables it creates.
  pgm.sql(`
    drop table if exists account_connection_events cascade;
    drop table if exists account_connection_credentials cascade;
    drop table if exists account_connections cascade;
    drop table if exists event_sync_imports cascade;
    drop table if exists event_blobs cascade;
    drop table if exists projection_checkpoints cascade;
    drop table if exists product_events cascade;
    drop table if exists artifacts cascade;
    drop table if exists events cascade;
    drop table if exists runs cascade;
    drop table if exists nodes cascade;
  `);
};
