// Turns a weekly class schedule into "what is happening now / next" for the AI snapshot.
// Uses the browser's IANA timezone so "today" matches the student, not the server.

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const pad2 = (n) => String(n).padStart(2, "0");
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function safeZone(timeZone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
    return timeZone;
  } catch {
    return "UTC";
  }
}

function localNow(timeZone = "UTC", date = new Date()) {
  const zone = safeZone(timeZone);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23"
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  const y = Number(get("year"));
  const m = Number(get("month"));
  const d = Number(get("day"));
  const hh = Number(get("hour"));
  const mm = Number(get("minute"));
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return { timeZone: zone, y, m, d, dow, hh, mm, hm: `${pad2(hh)}:${pad2(mm)}` };
}

function addDays(date, days) {
  const next = new Date(Date.UTC(date.y, date.m - 1, date.d + days));
  return { y: next.getUTCFullYear(), m: next.getUTCMonth() + 1, d: next.getUTCDate(), dow: next.getUTCDay() };
}

function fmtClock(hm) {
  const [hour, minute] = hm.split(":").map(Number);
  const suffix = hour >= 12 ? "PM" : "AM";
  const hour12 = hour % 12 || 12;
  return `${hour12}:${pad2(minute)} ${suffix}`;
}

function fmtDate(date, { year = false } = {}) {
  return `${DAY_NAMES[date.dow]}, ${MONTH_NAMES[date.m - 1]} ${date.d}${year ? `, ${date.y}` : ""}`;
}

// Returns the class in progress (if any) and the next `limit` class occurrences.
function upcomingSessions(schedules, timeZone = "UTC", date = new Date(), limit = 6) {
  const now = localNow(timeZone, date);
  const rows = [];
  let ongoing = null;

  for (const schedule of Array.isArray(schedules) ? schedules : []) {
    const day = Number(schedule.day_of_week);
    const start = String(schedule.start_time || "").slice(0, 5);
    const end = String(schedule.end_time || "").slice(0, 5);
    if (!Number.isInteger(day) || day < 0 || day > 6 || !TIME_RE.test(start) || !TIME_RE.test(end)) continue;

    if (day === now.dow && start <= now.hm && now.hm < end) ongoing = { ...schedule, start, end };

    let delta = (day - now.dow + 7) % 7;
    if (delta === 0 && start <= now.hm) delta = 7;
    rows.push({ ...schedule, start, end, delta, date: addDays(now, delta), sortKey: `${delta}:${start}` });
  }

  rows.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  return { now, ongoing, upcoming: rows.slice(0, limit) };
}

function describeSession(row) {
  const when = row.delta === 0 ? "Today" : row.delta === 1 ? "Tomorrow" : DAY_NAMES[row.date.dow];
  const subject = row.subject_name ? ` (${row.subject_name})` : "";
  const room = row.room ? ` in ${row.room}` : "";
  return `${when} (${MONTH_NAMES[row.date.m - 1]} ${row.date.d}, ${fmtClock(row.start)}-${fmtClock(row.end)}) ${row.title}${subject}${room}`;
}

function nowLine(now) {
  return `${fmtDate(now, { year: true })} at ${fmtClock(now.hm)} (${now.timeZone})`;
}

module.exports = { DAY_NAMES, localNow, upcomingSessions, describeSession, nowLine, fmtClock };
