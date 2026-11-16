const { Pool } = require("pg");

function createPool() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set. Copy .env.example to .env and fill it in.");
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined
  });
  pool.on("error", (error) => console.error("Unexpected database error:", error.message));
  return pool;
}

module.exports = { createPool };
