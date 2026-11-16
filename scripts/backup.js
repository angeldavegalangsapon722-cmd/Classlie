// One-shot PostgreSQL/Supabase backup.
//
//   npm run db:backup                 # dump DATABASE_URL -> backups/classlie-<timestamp>.sql.gz
//   npm run db:backup -- --keep 30    # keep the newest 30 dumps, prune the rest
//   npm run db:backup -- --cron       # print a ready-to-paste crontab line for nightly backups
//
// Requires the `pg_dump` binary (comes with PostgreSQL). Set BACKUP_DIR to change the output folder.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const BACKUP_DIR = process.env.BACKUP_DIR ? path.resolve(process.env.BACKUP_DIR) : path.join(ROOT, "backups");

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}
function hasFlag(flag) { return process.argv.includes(flag); }

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

// pg_dump talks SSL via the URL or PGSSLMODE. Mirror the app's DATABASE_SSL flag.
function dumpEnv() {
  const env = { ...process.env };
  if (env.DATABASE_SSL === "true" && !/sslmode=/.test(env.DATABASE_URL || "")) env.PGSSLMODE = "require";
  if (env.DATABASE_SSL === "false" && !/sslmode=/.test(env.DATABASE_URL || "")) env.PGSSLMODE = "disable";
  return env;
}

function printCron() {
  const line = `0 3 * * * cd ${ROOT} && /usr/bin/env npm run db:backup >> ${path.join(BACKUP_DIR, "backup.log")} 2>&1`;
  console.log("Nightly backups at 03:00 — run `crontab -e` and add:\n");
  console.log(`  ${line}\n`);
  console.log("Tip: macOS may need full-disk access for cron to read this folder.");
}

function prune(keep) {
  if (!(keep > 0)) return [];
  const files = fs.readdirSync(BACKUP_DIR)
    .filter((f) => /^classlie-.*\.sql\.gz$/.test(f))
    .map((f) => ({ f, t: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return files.slice(keep).map(({ f }) => {
    fs.unlinkSync(path.join(BACKUP_DIR, f));
    return f;
  });
}

function run() {
  if (hasFlag("--cron")) return printCron();
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set. Add it to .env first.");
    process.exit(1);
  }
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const target = path.join(BACKUP_DIR, `classlie-${timestamp()}.sql.gz`);
  const out = fs.createWriteStream(target);
  const gzip = zlib.createGzip();
  const dump = spawn("pg_dump", ["--no-owner", "--no-privileges", "--format=plain", url], { env: dumpEnv() });

  let stderr = "";
  dump.stderr.on("data", (d) => { stderr += d.toString(); });
  dump.on("error", (err) => {
    fs.rmSync(target, { force: true });
    console.error(err.code === "ENOENT"
      ? "pg_dump was not found. Install the PostgreSQL client tools (e.g. `brew install libpq`)."
      : `Backup failed: ${err.message}`);
    process.exit(1);
  });
  dump.stdout.pipe(gzip).pipe(out);

  dump.on("close", (code) => {
    if (code !== 0) {
      fs.rmSync(target, { force: true });
      console.error(`pg_dump exited with code ${code}.\n${stderr.trim()}`);
      process.exit(1);
    }
  });
  out.on("finish", () => {
    const kb = (fs.statSync(target).size / 1024).toFixed(1);
    const removed = prune(parseInt(argValue("--keep"), 10) || 14);
    console.log(`Backup saved: ${path.relative(ROOT, target)} (${kb} KB)`);
    if (removed.length) console.log(`Pruned ${removed.length} old backup(s).`);
    console.log("Schedule nightly runs with: npm run db:backup -- --cron");
  });
}

run();
