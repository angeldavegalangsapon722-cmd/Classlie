// Applies db/schema.sql. Safe to run repeatedly (all statements are idempotent).
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { createPool } = require("../src/db");

(async () => {
  const pool = createPool();
  try {
    const sql = fs.readFileSync(path.join(__dirname, "..", "db", "schema.sql"), "utf8");
    await pool.query(sql);
    console.log("Database schema is up to date.");
  } catch (error) {
    console.error("Schema setup failed:", error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
