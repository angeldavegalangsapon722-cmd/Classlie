// Restore a PostgreSQL/Supabase backup produced by `npm run db:backup`.
//
//   npm run db:restore -- backups/classlie-2026-10-17_03-00-00.sql.gz
//   npm run db:restore -- --latest            # restore the newest dump in backups/
//   npm run db:restore -- <file> --yes        # skip the confirmation prompt
//
// Requires the `psql` binary. This OVERWRITES data in the target database, so it asks first.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const readline = require("readline");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const BACKUP_DIR = process.env.BACKUP_DIR ? path.resolve(process.env.BACKUP_DIR) : path.join(ROOT, "backups");

function hasFlag(flag) { return process.argv.includes(flag); }
function positional() { return process.argv.slice(2).filter((a) => !a.startsWith("--")); }

function latestBackup() {
  if (!fs.existsSync(BACKUP_DIR)) return null;
  const files = fs.readdirSync(BACKUP_DIR)
    .filter((f) => /^classlie-.*\.sql(\.gz)?$/.test(f))
    .map((f) => ({ f, t: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return files.length ? path.join(BACKUP_DIR, files[0].f) : null;
}

function psqlEnv() {
  const env = { ...process.env };
  if (env.DATABASE_SSL === "true" && !/sslmode=/.test(env.DATABASE_URL || "")) env.PGSSLMODE = "require";
  if (env.DATABASE_SSL === "false" && !/sslmode=/.test(env.DATABASE_URL || "")) env.PGSSLMODE = "disable";
  return env;
}

function confirm(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => { rl.close(); resolve(/^y(es)?$/i.test(answer.trim())); });
  });
}

async function run() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("DATABASE_URL is not set. Add it to .env first."); process.exit(1); }
  const file = hasFlag("--latest") ? latestBackup() : positional()[0];
  if (!file) { console.error("Give a backup file, or use --latest.\n  npm run db:restore -- --latest"); process.exit(1); }
  if (!fs.existsSync(file)) { console.error(`No such file: ${file}`); process.exit(1); }

  console.log(`This will load ${path.relative(ROOT, file)} into the database.`);
  console.log("Existing rows with matching primary keys will be overwritten.");
  if (!hasFlag("--yes")) {
    const ok = await confirm("Continue? (y/N) ");
    if (!ok) { console.log("Cancelled."); return; }
  }

  const psql = spawn("psql", ["-v", "ON_ERROR_STOP=1", "--single-transaction", url], { env: psqlEnv() });
  let stderr = "";
  psql.stderr.on("data", (d) => { stderr += d.toString(); });
  psql.on("error", (err) => {
    console.error(err.code === "ENOENT"
      ? "psql was not found. Install the PostgreSQL client tools (e.g. `brew install libpq`)."
      : `Restore failed: ${err.message}`);
    process.exit(1);
  });

  const source = fs.createReadStream(file);
  if (file.endsWith(".gz")) source.pipe(zlib.createGunzip()).pipe(psql.stdin);
  else source.pipe(psql.stdin);

  psql.on("close", (code) => {
    if (code !== 0) { console.error(`psql exited with code ${code}.\n${stderr.trim()}`); process.exit(1); }
    console.log("Restore complete.");
  });
}

run();
