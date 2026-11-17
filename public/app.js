/* Classlie frontend — vanilla JS talking to the Express/PostgreSQL API. */
const TOKEN_KEY = "classlie_token";
const USER_KEY = "classlie_user";
const CLASS_KEY = "classlie_active_class";
const THEME_KEY = "classlie_theme";
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
  remove: (k) => { try { localStorage.removeItem(k); } catch { /* storage unavailable */ } }
};
// Keep me signed in -> localStorage (survives closing the browser); otherwise the tab session only.
const sessionStore = {
  get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { sessionStorage.setItem(k, v); } catch { /* storage unavailable */ } },
  remove: (k) => { try { sessionStorage.removeItem(k); } catch { /* storage unavailable */ } }
};
function getToken() { return store.get(TOKEN_KEY) || sessionStore.get(TOKEN_KEY); }
function setToken(value, remember = true) {
  if (remember) { store.set(TOKEN_KEY, value); sessionStore.remove(TOKEN_KEY); }
  else { sessionStore.set(TOKEN_KEY, value); store.remove(TOKEN_KEY); }
}
function clearToken() { store.remove(TOKEN_KEY); sessionStore.remove(TOKEN_KEY); store.remove(USER_KEY); sessionStore.remove(USER_KEY); }
function getCachedUser(){ try{return JSON.parse(store.get(USER_KEY)||sessionStore.get(USER_KEY));}catch{return null;}}
function setCachedUser(u, remember){ if(!u){store.remove(USER_KEY);sessionStore.remove(USER_KEY);return;} const s2=remember?store:sessionStore; const o=remember?sessionStore:store; o.remove(USER_KEY); s2.set(USER_KEY,JSON.stringify(u));}

const PREF_KEY = "classlie_prefs";
function loadPrefs() { try { return JSON.parse(store.get(PREF_KEY)) || {}; } catch { return {}; } }
function savePrefs(patch) { store.set(PREF_KEY, JSON.stringify({ ...loadPrefs(), ...patch })); }
const prefs = loadPrefs();
const cachedUserInit=getCachedUser(); const state = { token: getToken(), user: cachedUserInit, classes: [], activeClass: null, page: ["overview","schedule","tasks","notes","attendance","ai"].includes(prefs.page) ? prefs.page : "overview", authMode: "login", cache: {}, tasksFilter: prefs.tasksFilter || "all", taskSort: prefs.taskSort || "due", calDate: prefs.calDate || null, classMenuOpen: false, resetToken: null, scheduleEdit: false, taskEditMode: false, selected: { subjects: [], tasks: [] }, selectionActive: false, prevPage: "overview", aiChat: [], aiBusy: false };
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const colors = ["#003396", "#1750ac", "#3373c4", "#0000ff", "#527fc7", "#5b9bd5", "#244b82", "#7ba8df"];
const cid = () => state.activeClass.id;
let renderToken = 0;

/* ---------- shared UI and class helpers ---------- */
function isAdmin() { return !!state.activeClass && ["owner", "admin"].includes(state.activeClass.role); }
function isOwner() { return !!state.activeClass && state.activeClass.role === "owner"; }
function toast(message) {
  const el = $("#toast");
  if (!el) return;
  el.textContent = String(message || "");
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), 3200);
}
function pageHead(title, actions = "") { return `<div class="page-head"><div><p class="eyebrow">CLASSLIE</p><h2>${escapeHtml(title)}</h2></div>${actions}</div>`; }
function emptyState(title, detail) { return `<div class="empty"><strong>${escapeHtml(title)}</strong><p>${escapeHtml(detail)}</p></div>`; }
function actionButton(label, action, resource = "", primary = false) {
  return `<button type="button" class="${primary ? "primary" : "secondary"}" data-action="${escapeHtml(action)}"${resource ? ` data-resource="${escapeHtml(resource)}"` : ""}>${escapeHtml(label)}</button>`;
}
function avatarHtml(user = {}, cls = "") {
  const name = user.fullName || user.full_name || user.username || "User";
  const avatar = user.avatarUrl || user.avatar_url;
  return `<span class="avatar ${escapeHtml(cls)}">${avatar ? `<img src="${escapeHtml(avatar)}" alt="">` : escapeHtml(name.trim().slice(0, 1).toUpperCase())}</span>`;
}
function fmtTime(value) {
  if (!value) return "";
  const [h, m] = String(value).slice(0, 5).split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return String(value);
  const d = new Date(); d.setHours(h, m, 0, 0);
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}
function toMinutes(value) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(value || ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
function fromMinutes(value) { const mins = Math.max(0, Math.min(1439, Math.round(value))); return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`; }
function fmtDuration(value) { const mins = Math.max(0, Math.round(value)); return mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`; }
function fmtDate(value) {
  if (!value) return "";
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? new Date(`${value}T12:00:00`) : new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}
function fmtShortDate(value) { return fmtDate(value); }
function subjectAccent(name = "") { let n = 0; for (const ch of name) n = (n * 31 + ch.charCodeAt(0)) >>> 0; return colors[n % colors.length]; }
function subjectColor(subjectId, subjects = []) { return colors[Math.max(0, subjects.findIndex((s) => s.id === subjectId)) % colors.length]; }
function subjColor(item) { return subjectAccent(item.subject_name || item.title || ""); }
function trackEvent() { /* Analytics is optional; keep core actions independent of it. */ }
function taskCard(task, compact = false) {
  const due = task.due_at ? `<span class="task-due">${escapeHtml(fmtDate(task.due_at))}</span>` : "";
  const selected = state.selected.tasks.includes(task.id);
  const selectAttrs = isAdmin() && !task.is_private ? `data-selectable="tasks" data-select-id="${escapeHtml(task.id)}"` : "";
  const controls = isAdmin() && !task.is_private ? `<div class="inline-actions task-admin-actions"><button class="small-link" data-action="edit-item" data-resource="tasks" data-id="${task.id}">Edit</button><button class="small-link link-danger" data-action="delete-item" data-resource="tasks" data-id="${task.id}">Delete</button></div>` : "";
  return `<article class="item-card task-card${compact ? " compact" : ""}${selected ? " is-selected" : ""}" ${selectAttrs}><label class="task-check"><input class="task-toggle" type="checkbox" data-id="${escapeHtml(task.id)}" ${task.completed ? "checked" : ""} aria-label="Mark ${escapeHtml(task.title)} complete"></label><div class="item-main"><h3 class="task-title${task.completed ? " done" : ""}">${escapeHtml(task.title)}</h3>${task.description ? `<p>${escapeHtml(task.description)}</p>` : ""}${due}${controls}</div>${priorityDot(task.priority)}</article>`;
}
function minutesUntilNext(schedule) {
  const now = new Date();
  const start = toMinutes(schedule.start_time) ?? 0;
  const dayDelta = (Number(schedule.day_of_week) - now.getDay() + 7) % 7;
  const at = new Date(now); at.setDate(now.getDate() + dayDelta); at.setHours(Math.floor(start / 60), start % 60, 0, 0);
  if (at <= now) at.setDate(at.getDate() + 7);
  return at - now;
}
function occurrenceAt(schedule, edge, now = new Date()) {
  const targetMinutes = toMinutes(edge === "end" ? schedule.end_time : schedule.start_time) ?? 0;
  const targetDay = Number(schedule.day_of_week);
  const delta = (targetDay - now.getDay() + 7) % 7;
  const d = new Date(now); d.setDate(now.getDate() + delta); d.setHours(Math.floor(targetMinutes / 60), targetMinutes % 60, 0, 0);
  if (d <= now && edge === "start") d.setDate(d.getDate() + 7);
  return d;
}
function fmtCountdown(ms) {
  const mins = Math.max(0, Math.floor(ms / 60000));
  return mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
}
function isAdminRole(role) { return ["owner", "admin"].includes(role); }
function localDateStr(date = new Date()) { const d = new Date(date); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
function isSameDay(a, b) { const x = new Date(a), y = new Date(b); return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate(); }
function isDueSoon(task) { if (!task?.due_at || task.completed) return false; const delta = new Date(task.due_at).getTime() - Date.now(); return delta >= 0 && delta <= 48 * 60 * 60 * 1000; }
function nextOccurrence(session, from = new Date()) {
  if (session.kind === "date" && session.event_date) return String(session.event_date).slice(0, 10);
  const daysOfWeek = Array.isArray(session.days) ? session.days.map(Number) : [];
  if (!daysOfWeek.length) return localDateStr(from);
  for (let offset = 0; offset <= 7; offset++) {
    const day = new Date(from); day.setDate(from.getDate() + offset);
    if (daysOfWeek.includes(day.getDay())) return localDateStr(day);
  }
  return localDateStr(from);
}
/* ---------- theme ---------- */
function applyTheme(theme) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  store.set(THEME_KEY, theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = theme === "dark" ? "#101a2b" : "#003396";
  const button = document.getElementById("theme-toggle");
  if (button) {
    const label = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
    button.title = label;
    button.setAttribute("aria-label", label);
  }
}
function toggleTheme() {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(next);
}
function initTheme() {
  const saved = store.get(THEME_KEY);
  const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  applyTheme(saved || (prefersDark ? "dark" : "light"));
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}
// Small Markdown subset for reviewer notes. Input is escaped FIRST, so notes can never inject HTML.
function renderMarkdown(value = "") {
  const inline = (s) => s
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/\*\*|__/g, "");
  const out = [];
  let list = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of escapeHtml(value).split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) { closeList(); continue; }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) { closeList(); const level = Math.min(6, heading[1].length + 2); out.push(`<h${level}>${inline(heading[2])}</h${level}>`); continue; }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { closeList(); out.push("<hr>"); continue; }
    // Markdown tables read badly in a narrow bubble, so flatten each row to clean text.
    if ((line.match(/\|/g) || []).length >= 2) {
      const cells = line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      if (!cells.some(Boolean) || cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
      closeList();
      out.push(`<p class="md-row">${cells.filter(Boolean).map(inline).join(" · ")}</p>`);
      continue;
    }
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    const numbered = /^\d+\.\s+(.*)$/.exec(line);
    if (bullet) { if (list !== "ul") { closeList(); out.push("<ul>"); list = "ul"; } out.push(`<li>${inline(bullet[1])}</li>`); continue; }
    if (numbered) { if (list !== "ol") { closeList(); out.push("<ol>"); list = "ol"; } out.push(`<li>${inline(numbered[1])}</li>`); continue; }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join("");
}
// Plain, friendly rendering for AI chat: no messy tables or leftover markdown symbols.
function aiPlainText(value = "") {
  const lines = String(value).replace(/\r/g, "").split("\n").map((line) => {
    const t = line.trim();
    if (!t) return "";
    if (/^\|?[\s:|-]+\|?$/.test(t) && t.includes("-")) return null;
    if ((t.match(/\|/g) || []).length >= 2) {
      const cells = t.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      if (!cells.some(Boolean) || cells.every((c) => /^:?-{2,}:?$/.test(c))) return null;
      return cells.filter(Boolean).join(" · ");
    }
    return t.replace(/^#{1,6}\s+/, "").replace(/^\s*[-*]\s+/, "• ").replace(/\*\*|__|`/g, "");
  }).filter((x) => x !== null);
  return lines.join("\n");
}
function renderAiText(value = "") {
  return escapeHtml(aiPlainText(value));
}
// Priority is communicated by colour, not a wordy label.
function priorityDot(priority) {
  const p = ["low", "normal", "high"].includes(priority) ? priority : "normal";
  const label = `${p[0].toUpperCase()}${p.slice(1)} priority`;
  return `<span class="prio prio-${p}" title="${label}" aria-label="${label}"></span>`;
}
// A clearly-labelled, non-intrusive spot to drop an ad snippet later.
async function renderOverview() {
  const [tasks, regular, members, tempResult] = await Promise.all([
    fetchResource("tasks"), fetchResource("schedules"), api(`/classes/${cid()}/members`), api(`/class-data/${cid()}/temporary-schedules`)
  ]);
  const c = state.activeClass;
  const nextTasks = tasks.filter((t) => !t.completed).slice(0, 3);
  const todayKey = localDateStr(new Date());
  const activeTemp = (tempResult.temporary_schedules || []).find((x) => x.start_date <= todayKey && x.end_date >= todayKey);
  const schedules = activeTemp ? activeTemp.entries.filter((e) => e.entry_date >= todayKey).map((e) => ({ ...e, day_of_week: new Date(`${e.entry_date}T12:00:00`).getDay(), _date: e.entry_date })) : regular;
  const upcoming = activeTemp ? schedules : [...schedules].sort((a, b) => minutesUntilNext(a) - minutesUntilNext(b)).slice(0, 4);
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const todayIdx = now.getDay();
  // Headline: the class happening right now, otherwise the soonest one — with a live countdown.
  const running = schedules
    .filter((s) => Number(s.day_of_week) === todayIdx && nowMin >= (toMinutes(s.start_time) ?? 0) && nowMin < (toMinutes(s.end_time) ?? 0))
    .sort((a, b) => (toMinutes(a.end_time) ?? 0) - (toMinutes(b.end_time) ?? 0));
  const isLive = running.length > 0;
  const focus = running[0] || upcoming[0];
  let hero = "";
  if (focus) {
    const which = isLive ? "end" : "start";
    const target = focus._date
      ? new Date(`${focus._date}T${String(focus[which === "end" ? "end_time" : "start_time"]).slice(0, 5)}:00`)
      : occurrenceAt(focus, which, now);
    const remaining = Math.max(0, target - now);
    hero = `<div class="upnext-hero">
      <div class="upnext-text"><p class="eyebrow">${activeTemp ? escapeHtml(activeTemp.title) : isLive ? "HAPPENING NOW" : "UP NEXT"}</p><h3>${escapeHtml(focus.title)}</h3>
      <p>${focus._date || days[focus.day_of_week]} · ${fmtTime(focus.start_time)}–${fmtTime(focus.end_time)}${focus.room ? " · " + escapeHtml(focus.room) : ""}</p></div>
      <div class="upnext-count"><span class="count-num" id="next-class-countdown" data-target="${target.toISOString()}" data-mode="${which}">${which === "end" ? "Ends in " : "Starts in "}${fmtCountdown(remaining)}</span><span class="stat-label">${which === "end" ? "CLASS ENDS" : "CLASS STARTS"}</span></div>
    </div>`;
  }
  const alsoUpcoming = upcoming.filter((s) => s.id !== (focus && focus.id)).slice(0, 3);
  const upcomingGroups = new Map();
  alsoUpcoming.forEach((schedule) => {
    const at = occurrenceAt(schedule, "start", now);
    const key = localDateStr(at);
    if (!upcomingGroups.has(key)) {
      const delta = Math.round((new Date(`${key}T00:00:00`) - new Date(`${localDateStr(now)}T00:00:00`)) / 86400000);
      const label = delta <= 0 ? "Today" : delta === 1 ? "Tomorrow" : delta > 6 ? at.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" }) : at.toLocaleDateString([], { weekday: "long" });
      upcomingGroups.set(key, { label, items: [] });
    }
    upcomingGroups.get(key).items.push(schedule);
  });
  const alsoUpcomingHtml = [...upcomingGroups.values()].map(({ label, items }) =>
    `<section class="upcoming-day-group"><h4 class="upcoming-day-heading">${escapeHtml(label)}</h4><div class="item-list">${items.map((s) => `<div class="item-card"><div class="class-avatar">◷</div><div class="item-main"><h3>${escapeHtml(s.title)}</h3><p>${days[s.day_of_week]} · ${fmtTime(s.start_time)}–${fmtTime(s.end_time)}${s.room ? " · " + escapeHtml(s.room) : ""}</p></div></div>`).join("")}</div></section>`
  ).join("");
  const classCards = state.classes.map((k) => `<div class="class-card"><div class="class-avatar">${escapeHtml(k.name.slice(0, 1).toUpperCase())}</div><div class="item-main"><h3>${escapeHtml(k.name)}</h3><p>${k.member_count} members</p></div><span class="pill">${escapeHtml(k.role)}</span></div>`).join("");
  const firstName = (state.user?.fullName || "there").trim().split(/\s+/)[0];
  return `${pageHead(`Good evening, ${firstName}`)}
  <div class="grid home-grid">
    <div class="panel span-12 home-up-next"><div class="section-title"><h3>Up Next</h3><button class="small-link" data-page-link="schedule">Open schedule →</button></div>
      ${hero || emptyState("No schedule yet", "Admins can add class times to fill this in.")}
      ${alsoUpcoming.length ? `<div class="section-title sub-title"><h3 class="sub">Also coming up</h3></div>${alsoUpcomingHtml}` : ""}
    </div>
    <div class="panel span-12"><div class="section-title"><h3>Tasks</h3><button class="small-link" data-page-link="tasks">View all →</button></div><div class="item-list">${nextTasks.length ? nextTasks.map((t) => taskCard(t, true)).join("") : emptyState("All caught up", "No unfinished tasks right now.")}</div></div>
    <div class="panel span-12"><div class="section-title"><h3>Class details</h3>${isOwner() ? `<button class="secondary button-sm" data-action="edit-class">Edit class</button>` : `<button class="small-link link-danger" data-action="leave-class">Leave class</button>`}</div>
      <div class="class-meta class-meta-primary">
        <button type="button" class="meta-chip meta-button" data-action="members"><span class="stat-label">MEMBERS</span><strong>${members.members.length}</strong><span class="meta-arrow">›</span></button>
        <div class="meta-chip"><span class="stat-label">CODE</span><span class="class-code" id="class-code">${escapeHtml(c.code)}</span><button class="small-link" data-action="copy-code">Copy</button></div>
        <div class="meta-chip"><span class="stat-label">ROLE</span><span class="pill">${escapeHtml(c.role)}</span></div>
        <button type="button" class="meta-chip meta-button" data-action="activity"><span class="stat-label">ACTIVITY</span><span class="meta-arrow">›</span></button>
      </div>
    </div>
    <div class="panel span-12"><div class="section-title"><h3>Your classrooms</h3><button class="small-link" data-action="create-class">＋ Add class</button></div><div class="item-list">${classCards}</div></div>
  </div>`;
}
async function renderTasks() {
  const [tasks] = await Promise.all([fetchResource("tasks"), fetchResource("subjects")]);
  state.cache.tasks = tasks;
  const now = new Date();
  const filtered = tasks.filter((t) => {
    if (state.tasksFilter === "done") return t.completed;
    if (state.tasksFilter === "todo") return !t.completed;
    if (state.tasksFilter === "overdue") return !t.completed && t.due_at && new Date(t.due_at) < now;
    return true;
  });
  const counts = { all: tasks.length, todo: 0, done: 0, overdue: 0 };
  tasks.forEach((t) => {
    if (t.completed) counts.done += 1; else counts.todo += 1;
    if (!t.completed && t.due_at && new Date(t.due_at) < now) counts.overdue += 1;
  });
  const rank = { high: 0, normal: 1, low: 2 };
  const dueAt = (v) => (v ? new Date(v).getTime() : Number.MAX_SAFE_INTEGER);
  const sorted = [...filtered].sort((a, b) => {
    if (state.taskSort === "priority") return (rank[a.priority] ?? 1) - (rank[b.priority] ?? 1) || dueAt(a.due_at) - dueAt(b.due_at);
    if (state.taskSort === "created") return new Date(b.created_at) - new Date(a.created_at);
    return dueAt(a.due_at) - dueAt(b.due_at);
  });
  const tabs = [["all", "All"], ["todo", "To do"], ["done", "Done"], ["overdue", "Overdue"]]
    .map(([k, label]) => `<button class="filter-tab ${state.tasksFilter === k ? "active" : ""}" data-task-filter="${k}">${label}<span class="tab-count">${counts[k]}</span></button>`).join("");
  const sortOptions = [["due", "Due date"], ["priority", "Priority"], ["created", "Newest"]]
    .map(([k, label]) => `<option value="${k}" ${state.taskSort === k ? "selected" : ""}>${label}</option>`).join("");
  const taskItems = sorted.length
    ? sorted.map((task) => taskCard(task)).join("")
    : emptyState("No tasks here", state.tasksFilter === "all"
      ? "Add a task for the class, or a private one only you can see."
      : "Nothing matches this filter.");

  return `${pageHead("Tasks", `<div class="action-row tasks-actions">${actionButton("＋ Add task", "add-item", "tasks")}</div>`)}
    <div class="tasks-content-grid">
      <div class="panel tasks-list-panel${state.taskEditMode ? " task-editing" : ""}">
        <div class="section-title">
          <h3>Task list</h3>
          <div class="task-list-tools"><span class="pill">${counts.done}/${counts.all} completed</span>${isAdmin() ? `<button type="button" class="icon-button task-edit-toggle${state.taskEditMode ? " active" : ""}" data-action="toggle-task-edit" aria-label="Toggle task editing" title="Edit tasks">✎</button>` : ""}</div>
        </div>
        <div class="filters">
          <div class="filter-tabs">${tabs}</div>
          <label class="filter-sort">Sort<select data-task-sort aria-label="Sort tasks">${sortOptions}</select></label>
        </div>
        <div class="item-list">${taskItems}</div>
      </div>
      <div id="calendar-section" class="calendar-section panel">
        ${calendarHtml(tasks)}
      </div>
    </div>`;
}
async function renderSchedule() {
  const [regular, subjects, tempResult] = await Promise.all([fetchResource("schedules"), fetchResource("subjects"), api(`/class-data/${cid()}/temporary-schedules`)]);
  const todayKey = localDateStr(new Date());
  const activeTemp = (tempResult.temporary_schedules || []).find((x) => x.start_date <= todayKey && x.end_date >= todayKey);
  const schedules = activeTemp ? activeTemp.entries.filter((e) => e.entry_date >= todayKey).map((e) => ({ ...e, day_of_week: new Date(`${e.entry_date}T12:00:00`).getDay(), title: e.title, _date: e.entry_date })) : regular;
  const editing = isAdmin() && state.scheduleEdit && !activeTemp;
  const editBtn = (s) => `<button class="small-link" data-action="edit-item" data-resource="schedules" data-id="${s.id}">Edit</button>`;
  const delBtn = (s) => `<button class="small-link link-danger" data-action="delete-item" data-resource="schedules" data-id="${s.id}">Delete</button>`;
  const subjectName = (id) => subjects.find((subject) => subject.id === id)?.name || "";
  const subjColor = (s) => subjectAccent(subjectName(s.subject_id));
  const byDay = days.map((name, index) => `<div class="day-column"><h4>${name.toUpperCase()}</h4>${schedules.filter((s) => Number(s.day_of_week) === index).map((s) =>
    `<div class="schedule-chip" style="--accent:${escapeHtml(subjColor(s))}"><strong>${escapeHtml(s.title)}</strong><span>${fmtTime(s.start_time)}–${fmtTime(s.end_time)}</span>${s.room ? `<br><span>${escapeHtml(s.room)}</span>` : ""}${editing ? `<div style="margin-top:7px">${editBtn(s)}</div>` : ""}</div>`).join("") || `<span class="muted" style="font-size:.75rem">No classes</span>`}</div>`).join("");
  // Agenda: a phone-friendly day-by-day list (today highlighted) shown instead of the week columns on narrow screens. Days with no classes are skipped.
  const todayIdx = new Date().getDay();
  const agenda = days.map((name, index) => {
    const list = schedules.filter((s) => Number(s.day_of_week) === index).sort((a, b) => toMinutes(a.start_time) - toMinutes(b.start_time));
    if (!list.length) return "";
    const isToday = index === todayIdx;
    const items = list.map((s) => `<div class="agenda-item" style="--accent:${escapeHtml(subjColor(s))}">
      <div class="agenda-time"><strong>${escapeHtml(fmtTime(s.start_time))}</strong><span>${escapeHtml(fmtTime(s.end_time))}</span></div>
      <div class="agenda-info"><h5>${escapeHtml(s.title)}</h5>${s.room ? `<span class="agenda-room">${escapeHtml(s.room)}</span>` : ""}${editing ? `<div class="agenda-actions">${editBtn(s)}${delBtn(s)}</div>` : ""}</div></div>`).join("");
    return `<div class="agenda-day${isToday ? " today" : ""}">
      <div class="agenda-day-head"><h4>${escapeHtml(name)}</h4>${isToday ? `<span class="pill">Today</span>` : ""}<span class="pill">${list.length} class${list.length === 1 ? "" : "es"}</span></div>
      <div class="agenda-items">${items}</div></div>`;
  }).join("");
  const rows = schedules.map((s) => `<tr><td>${s._date || days[s.day_of_week]}</td><td>${escapeHtml(s.title)}${s.subject ? ` · ${escapeHtml(s.subject)}` : ""}</td><td>${fmtTime(s.start_time)}–${fmtTime(s.end_time)}</td><td>${escapeHtml(s.room || "—")}</td><td>${editing ? `${editBtn(s)} ${delBtn(s)}` : ""}</td></tr>`).join("");
  const actions = isAdmin() ? `<div class="action-row schedule-actions"><button type="button" class="${state.scheduleEdit ? "primary" : "secondary"}" data-action="toggle-schedule-edit">${state.scheduleEdit ? "✓ Done" : "✎ Edit"}</button>${actionButton("✦ Import schedule", "scan-schedule", "", true)}${actionButton("＋ Add schedule", "add-item", "schedules")}</div>` : "";
  return `${pageHead(`Schedule${activeTemp ? ` · ${activeTemp.title}` : ""}`, actions)}
  <div class="panel"><div class="section-title"><h3>This week</h3><span class="pill">${schedules.length} entries</span></div>${schedules.length ? `<div class="week-grid">${byDay}</div><div class="agenda">${agenda}</div>` : emptyState("No schedule yet", "An admin can add a subject, day, start time, end time, and room.")}</div>
  ${schedules.length ? `<div class="panel schedule-table" style="margin-top:17px"><div class="section-title"><h3>Schedule entries</h3></div><div class="table-wrap"><table><thead><tr><th>Day</th><th>Class / subject</th><th>Time</th><th>Room</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></div>` : ""}`;
}
// ---- AI schedule import (admin): scan a photo/text, then review before saving ----
function openScheduleScan() {
  openModal("Import a schedule", "AI SCAN", `
    <label>Schedule photo<input type="file" id="scan-image" accept="image/*"></label>
    <label>…or paste the schedule text<textarea id="scan-text" maxlength="8000" placeholder="e.g. Monday 7:30–9:00 Object-Oriented Programming, Lab 2"></textarea></label>
    <label class="check-row"><input type="checkbox" id="scan-temporary"> Temporary schedule</label>
    <div id="scan-temporary-fields" hidden><label>Schedule label<input id="scan-temp-title" maxlength="120" placeholder="Exam Week"></label><div class="two-col"><label>Start date<input id="scan-temp-start" type="date" value="${localDateStr(new Date())}"></label><label>End date<input id="scan-temp-end" type="date" value="${localDateStr(new Date())}"></label></div></div>
    <p class="form-error" id="scan-error" role="alert"></p>
    <div class="modal-actions"><button type="button" class="secondary" id="scan-cancel">Cancel</button><button type="button" class="primary" id="scan-go">Scan with AI</button></div>`);
  $("#scan-cancel").onclick = closeModal;
  $("#scan-temporary").onchange = (event) => { $("#scan-temporary-fields").hidden = !event.target.checked; };
  $("#scan-go").onclick = async () => {
    const button = $("#scan-go");
    const file = $("#scan-image").files[0];
    const text = $("#scan-text").value.trim();
    if (!file && !text) { $("#scan-error").textContent = "Add a photo or paste some text first."; return; }
    button.disabled = true;
    button.textContent = "Scanning…";
    try {
      const form = new FormData();
      if (file) form.append("image", file);
      if (text) form.append("text", text);
      const { entries, schedule = {}, skipped } = await apiUpload(`/class-data/${cid()}/schedules/scan`, form);
      const detectedDates = !!(schedule.start_date && schedule.end_date);
      showScheduleScanPreview(entries, skipped, { temporary: $("#scan-temporary").checked || detectedDates, title: schedule.title || $("#scan-temp-title").value, start: schedule.start_date || $("#scan-temp-start").value, end: schedule.end_date || $("#scan-temp-end").value });
    } catch (error) {
      $("#scan-error").textContent = error.message;
      button.disabled = false;
      button.textContent = "Scan with AI";
    }
  };
}

function showScheduleScanPreview(entries, skipped, temporary = {}) {
  if (!entries.length) {
    openModal("Import a schedule", "AI SCAN", `<p class="hint">The scan didn't find any class entries. Try a clearer photo, or paste the schedule as text.</p>
      <div class="modal-actions"><button type="button" class="secondary" id="scan-back">Try again</button></div>`);
    $("#scan-back").onclick = openScheduleScan;
    return;
  }
  const rows = entries.map((e) => `<tr>
    <td><input type="checkbox" class="scan-include" checked></td>
    <td><input type="text" class="scan-title" value="${escapeHtml(e.title)}" maxlength="160"></td>
    <td><input type="text" class="scan-subject" value="${escapeHtml(e.subject || "")}" maxlength="120" placeholder="—"></td>
    <td><select class="scan-day">${days.map((d, i) => `<option value="${i}" ${e.day === i ? "selected" : ""}>${d}</option>`).join("")}</select></td>
    <td><input type="time" class="scan-start" value="${e.start_time || "08:00"}" step="900"></td>
    <td><input type="time" class="scan-end" value="${e.end_time || "09:00"}" step="900"></td>
    <td><input type="text" class="scan-room" value="${escapeHtml(e.room || "")}" maxlength="100" placeholder="—"></td>
  </tr>`).join("");
  const note = `<p class="hint">Found ${entries.length} entr${entries.length === 1 ? "y" : "ies"}${skipped ? ` (${skipped} unreadable row${skipped === 1 ? "" : "s"} skipped)` : ""}. Edit anything that's wrong, untick rows you don't want, then import. New subject names are added automatically.</p>`;
  openModal("Review scanned schedule", "AI SCAN", `${note}
    <label class="check-row"><input type="checkbox" id="scan-temporary" ${temporary.temporary ? "checked" : ""}> Temporary schedule</label>
    <div id="scan-temporary-fields" ${temporary.temporary ? "" : "hidden"}><label>Schedule label<input id="scan-temp-title" maxlength="120" placeholder="Exam Week" value="${escapeHtml(temporary.title || "")}"></label><div class="two-col"><label>Start date<input id="scan-temp-start" type="date" value="${escapeHtml(temporary.start || localDateStr(new Date()))}"></label><label>End date<input id="scan-temp-end" type="date" value="${escapeHtml(temporary.end || localDateStr(new Date()))}"></label></div></div>
    <div class="table-wrap"><table class="scan-table"><thead><tr><th></th><th>Title</th><th>Subject</th><th>Day</th><th>Start</th><th>End</th><th>Room</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="form-error" id="scan-error" role="alert"></p>
    <div class="modal-actions"><button type="button" class="secondary" id="scan-back">Back</button><button type="button" class="primary" id="scan-save">Import selected</button></div>`);
  $("#scan-back").onclick = openScheduleScan;
  $("#scan-temporary").onchange = (event) => { $("#scan-temporary-fields").hidden = !event.target.checked; };
  $("#scan-save").onclick = async () => {
    const body = $("#modal-body");
    const payload = $$("tbody tr", body).filter((tr) => $(".scan-include", tr).checked).map((tr) => ({
      title: $(".scan-title", tr).value.trim(),
      subject: $(".scan-subject", tr).value.trim(),
      day: $(".scan-day", tr).value,
      start_time: $(".scan-start", tr).value,
      end_time: $(".scan-end", tr).value,
      room: $(".scan-room", tr).value.trim()
    }));
    if (!payload.length) { $("#scan-error").textContent = "Select at least one row to import."; return; }
    const button = $("#scan-save");
    button.disabled = true;
    try {
      let imported;
      if ($("#scan-temporary").checked) {
        const start = $("#scan-temp-start").value, end = $("#scan-temp-end").value, label = $("#scan-temp-title").value.trim();
        if (!label || !start || !end || end < start) throw new Error("Enter a schedule label and valid date range.");
        const entries = [];
        for (const entry of payload) {
          const date = new Date(`${start}T12:00:00`);
          while (localDateStr(date) <= end) {
            if (date.getDay() === Number(entry.day)) entries.push({ title: entry.title, subject: entry.subject, entry_date: localDateStr(date), start_time: entry.start_time, end_time: entry.end_time, room: entry.room });
            date.setDate(date.getDate() + 1);
          }
        }
        if (!entries.length) throw new Error("No scanned weekdays fall within the selected date range.");
        await api(`/class-data/${cid()}/temporary-schedules`, { method: "POST", body: { title: label, start_date: start, end_date: end, entries } });
        imported = entries.length;
      } else {
        const result = await api(`/class-data/${cid()}/schedules/import`, { method: "POST", body: { entries: payload } });
        imported = result.imported;
      }
      closeModal();
      toast(`Imported ${imported} schedule entr${imported === 1 ? "y" : "ies"}.`);
      await renderPage();
    } catch (error) {
      $("#scan-error").textContent = error.message;
      button.disabled = false;
    }
  };
}

// Monthly deadline calendar, shown beneath the task list.
function calendarHtml(tasks) {
  const today = new Date();
  const anchor = state.calDate ? new Date(state.calDate) : new Date(today.getFullYear(), today.getMonth(), 1);
  const year = anchor.getFullYear();
  const month = anchor.getMonth();
  const startOffset = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const byDay = new Map();
  tasks.forEach((t) => {
    if (!t.due_at) return;
    const d = new Date(t.due_at);
    if (d.getMonth() === month && d.getFullYear() === year) {
      const key = d.getDate();
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(t);
    }
  });
  const heads = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((h) => `<div class="cal-head">${h.toUpperCase()}</div>`).join("");
  const cells = [];
  for (let i = 0; i < startOffset; i++) cells.push('<div class="cal-day other"></div>');
  for (let day = 1; day <= daysInMonth; day++) {
    const date = new Date(year, month, day);
    const list = byDay.get(day) || [];
    const chips = list.slice(0, 3).map((t) => {
      const overdue = !t.completed && t.due_at && new Date(t.due_at) < today;
      const dueSoon = isDueSoon(t);
      return `<span class="cal-dot ${overdue || dueSoon ? "due" : ""}" title="${escapeHtml(t.title)}" aria-label="${escapeHtml(t.title)}"></span>`;
    }).join("");
    const more = list.length > 3 ? `<span class="cal-more">+${list.length - 3}</span>` : "";
    const todayCell = isSameDay(date, today) ? " today" : "";
    cells.push(`<div class="cal-day${todayCell}" data-cal-day="${day}" aria-label="${date.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}, ${list.length} task${list.length === 1 ? "" : "s"}"><span class="cal-num">${day}</span>${list.length ? `<span class="cal-indicators">${chips}${more}</span>` : ""}</div>`);
  }
  const padding = (7 - ((startOffset + daysInMonth) % 7)) % 7;
  for (let i = 0; i < padding; i++) cells.push('<div class="cal-day other"></div>');
  const monthLabel = anchor.toLocaleString([], { month: "long", year: "numeric" });
  return `<div class="cal-toolbar" style="margin-bottom:16px"><h3 style="margin:0">${monthLabel}</h3><div class="inline-actions"><button type="button" class="secondary" data-action="cal-prev">← Prev</button><button type="button" class="secondary" data-action="cal-today">Today</button><button type="button" class="secondary" data-action="cal-next">Next →</button></div></div>
  <div class="cal-grid">${heads}${cells.join("")}</div>`;
}
async function openCalDay(dayNumber) {
  const anchor = state.calDate ? new Date(state.calDate) : new Date();
  const d = new Date(anchor.getFullYear(), anchor.getMonth(), Number(dayNumber));
  const [tasks, schedules] = await Promise.all([fetchResource("tasks"), fetchResource("schedules")]);
  const dueTasks = tasks.filter((t) => t.due_at && isSameDay(new Date(t.due_at), d));
  const todaysClasses = schedules.filter((s) => Number(s.day_of_week) === d.getDay()).sort((a, b) => toMinutes(a.start_time) - toMinutes(b.start_time));
  const blocks = [];
  if (todaysClasses.length) {
    blocks.push(`<div class="group-label">CLASSES</div><div class="item-list">${todaysClasses.map((s) => `<div class="item-card"><div class="class-avatar">◷</div><div class="item-main"><h3>${escapeHtml(s.title)}</h3><p>${fmtTime(s.start_time)}–${fmtTime(s.end_time)}${s.room ? " · " + escapeHtml(s.room) : ""}</p></div></div>`).join("")}</div>`);
  }
  if (dueTasks.length) {
    blocks.push(`<div class="group-label" style="margin-top:16px">DUE</div><div class="item-list">${dueTasks.map((t) => taskCard(t)).join("")}</div>`);
  }
  if (!blocks.length) blocks.push(`<div class="empty">Nothing due or scheduled on ${d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}.</div>`);
  openModal(d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" }), "CALENDAR", blocks.join(""));
}

async function navigateCalendar(action) {
  const container = $("#calendar-section");
  if (state.page === "tasks" && container?.classList.contains("is-loading")) return;

  const previousDate = state.calDate;
  const base = state.calDate ? new Date(state.calDate) : new Date();
  state.calDate = (action === "cal-today"
    ? new Date(new Date().getFullYear(), new Date().getMonth(), 1)
    : new Date(base.getFullYear(), base.getMonth() + (action === "cal-next" ? 1 : -1), 1)).toISOString();
  savePrefs({ calDate: state.calDate });

  if (state.page !== "tasks" || !container || !Array.isArray(state.cache.tasks)) return renderPage();
  container.classList.add("is-loading");
  container.setAttribute("aria-busy", "true");
  await new Promise((resolve) => requestAnimationFrame(resolve));
  try {
    if (!container.isConnected) return;
    state.cache.tasks = await fetchResource("tasks");
    if (!container.isConnected) return;
    container.innerHTML = calendarHtml(state.cache.tasks);
    $$('[data-action^="cal-"]', container).forEach((button) => button.addEventListener("click", async (event) => {
      event.preventDefault();
      try { await withButtonLoading(button, () => navigateCalendar(button.dataset.action)); }
      catch (error) { toast(error.message); }
    }));
    $$('[data-cal-day]', container).forEach((day) => day.addEventListener("click", () => openCalDay(day.dataset.calDay).catch((error) => toast(error.message))));
  } catch (error) {
    state.calDate = previousDate;
    savePrefs({ calDate: previousDate });
    toast(error.message || "Couldn’t refresh the calendar.");
  } finally {
    container.classList.remove("is-loading");
    container.removeAttribute("aria-busy");
  }
}

async function renderNotes() {
  const [subjects, { summary }, { quizzes }] = await Promise.all([
    fetchResource("subjects"), api(`/class-data/${cid()}/reviewer-summary`), api(`/ai/${cid()}/quizzes`)
  ]);
  const quizCounts = {};
  for (const q of quizzes) if (q.subject_id) quizCounts[q.subject_id] = (quizCounts[q.subject_id] || 0) + 1;
  const subjectCards = subjects.map((s) => {
    const reviews = summary[s.id] || 0;
    const qz = quizCounts[s.id] || 0;
    const stats = [`${reviews} reviewer${reviews === 1 ? "" : "s"}`];
    if (qz) stats.push(`${qz} ${qz === 1 ? "quiz" : "quizzes"}`);
    const accent = subjectAccent(s.name);
    const selected = state.selected.subjects.includes(s.id);
    const selectAttrs = isAdmin() ? `data-selectable="subjects" data-select-id="${s.id}"` : "";
    return `<div class="subject-card${selected ? " is-selected" : ""}" style="--subject-accent:${accent}" ${selectAttrs}><button class="subject-open" data-action="open-subject" data-id="${s.id}"><h3><span class="subject-title"><span class="subject-dot" style="background:${accent}"></span><span class="subject-name">${escapeHtml(s.name)}</span></span></h3><p>${stats.join(" · ")}</p></button>${isAdmin() ? `<div><button class="small-link" data-action="edit-item" data-resource="subjects" data-id="${s.id}">Edit subject</button></div>` : ""}</div>`;
  }).join("");
  const unassigned = quizzes.filter((q) => !q.subject_id);
  return `${pageHead("Subjects",
    `<div class="action-row notes-actions"><button class="secondary" data-action="ai-reviewer">✦ AI reviewer</button><button class="secondary" data-action="ai-quiz">✦ Build a quiz</button>${isAdmin() ? actionButton("＋ Add subject", "add-item", "subjects", true) : ""}</div>`)}
  <div class="panel">
  ${subjects.length ? `<div class="subject-grid">${subjectCards}</div>` : emptyState("No subjects yet", "Admins can create subjects to organize reviewers.")}</div>
  ${unassigned.length ? `<div class="panel" style="margin-top:17px"><div class="section-title"><h3>Other quizzes</h3><span class="pill">${unassigned.length}</span></div>
    <div class="item-list">${unassigned.map(quizCard).join("")}</div></div>` : ""}`;
}

async function renderAttendance() {
  const [{ sessions }, summary] = await Promise.all([
    api(`/attendance/${cid()}/sessions`),
    api(`/attendance/${cid()}/attendance/summary`).catch(() => null)
  ]);
  const cards = sessions.map((s) => {
    const when = s.kind === "date"
      ? `One-off · ${escapeHtml(fmtShortDate(s.event_date))}`
      : `Weekly · ${escapeHtml((s.days || []).map((d) => days[d]).join(", ") || "—")}`;
    const times = s.start_time ? ` · ${fmtTime(s.start_time)}–${fmtTime(s.end_time)}` : "";
    const subject = s.subject_name ? ` · ${escapeHtml(s.subject_name)}` : "";
    return `<article class="item-card"><div class="class-avatar">☑</div><div class="item-main"><h3>${escapeHtml(s.name)}</h3><p>${when}${times}${subject}</p></div>
      <div class="inline-actions"><button class="secondary" data-att-take="${s.id}">${isAdmin() ? "Take" : "View"}</button>${isAdmin() ? `<button class="small-link" data-att-edit="${s.id}">Edit</button>` : ""}</div></article>`;
  }).join("");
  const attendanceActions = `<div class="action-row attendance-actions">${isAdmin() ? actionButton("＋ Add session", "add-attendance") : ""}</div>`;
  return `${pageHead("Attendance", attendanceActions)}
  <div class="attendance-content-grid">
    ${attendanceSummaryPanel(summary, sessions.length)}
    <div class="panel attendance-sessions-panel">
      <div class="section-title"><h3>Sessions</h3><span class="pill">${sessions.length}</span></div>
      <div class="item-list">${cards || emptyState("No attendance sessions yet", "Admins can add recurring sessions (e.g. every Monday) or a single event.")}</div>
    </div>
  </div>`;
}

// A member's own attendance rate, overall and per subject. Attended = present + late.
// A member's own attendance rate, overall and per subject. Attended = present.
function attendanceSummaryPanel(summary, sessionCount = 0) {
  if (!summary) return "";
  const o = summary.overall || {};
  const present = Number(o.present ?? 0) || 0;
  const absent = Number(o.absent ?? 0) || 0;
  const counted = Number(o.counted ?? (present + absent)) || 0;
  const rateVal = o.rate === null || o.rate === undefined ? null : Number(o.rate);
  const tone = rateVal === null || Number.isNaN(rateVal) ? "" : rateVal >= 90 ? "green" : rateVal >= 75 ? "" : "red";
  const rate = rateVal === null || Number.isNaN(rateVal) ? "—" : `${rateVal}%`;
  const subjects = Array.isArray(summary.subjects) ? summary.subjects : [];
  const rows = subjects.map((s) => {
    const r = s.rate === null || s.rate === undefined ? null : Number(s.rate);
    const att = Number(s.attended ?? 0) || 0;
    const abs = Number(s.absent ?? 0) || 0;
    const rate = r === null || Number.isNaN(r) ? "—" : `${r}%`;
    const rateTone = r === null || Number.isNaN(r) ? "muted" : r >= 90 ? "green" : r >= 75 ? "amber" : "red";
    return `<tr><td>${escapeHtml(s.subject_name)}</td><td>${att}</td><td>${abs}</td><td><span class="att-rate-badge ${rateTone}">${rate}</span></td></tr>`;
  }).join("");
  const body = `<div class="att-summary-strip"><div><span>Sessions</span><strong>${Number(sessionCount) || 0}</strong></div><div><span>Present</span><strong class="green-t">${present}</strong></div><div><span>Absent</span><strong class="red-t">${absent}</strong></div></div>
    ${counted === 0 ? emptyState("No attendance recorded yet", "Once your teacher marks a session, your rate shows up here.") : rows ? `<div class="att-summary-table-wrap"><table class="att-summary-table"><thead><tr><th>Subject</th><th>Attended</th><th>Absent</th><th>Rate</th></tr></thead><tbody>${rows}</tbody></table></div>` : ""}`;
  return `<div class="panel att-panel-compact attendance-summary-panel" style="margin-bottom:17px"><div class="section-title"><h3>My attendance</h3><span class="pill ${tone}">${rate}</span></div>${body}</div>`;
}

/* ---------- modal + forms ---------- */
function openModal(title, eyebrow, html) {
  const modal = $("#modal");
  if (!modal) return;
  modal.classList.remove("wide");
  const titleEl = $("#modal-title");
  const eyebrowEl = $("#modal-eyebrow");
  const bodyEl = $("#modal-body");
  if (titleEl) titleEl.textContent = title;
  if (eyebrowEl) eyebrowEl.textContent = eyebrow;
  if (bodyEl) bodyEl.innerHTML = html;
  document.body.classList.add("modal-open");
  if (!modal.open) modal.showModal();
}
function closeModal() {
  const modal = $("#modal");
  if (!modal) return;
  if (modal.open) modal.close();
  modal.classList.remove("wide");
  document.body.classList.remove("modal-open");
}
// AI study dialogs need more room than a plain form.
function openWideModal(title, eyebrow, html) {
  const modal = $("#modal");
  openModal(title, eyebrow, html);
  if (modal) modal.classList.add("wide");
}

// onSubmit / onDelete may return a function: it runs after the dialog closes (e.g. to re-open the parent dialog).
function modalForm({ title, eyebrow, html, submitLabel = "Save", onSubmit, onDelete, deleteLabel = "Delete", confirmDelete = true, onCancel }) {
  openModal(title, eyebrow || "CLASSLIE", `<form id="dynamic-form">${html}<p class="form-error" id="modal-error" role="alert"></p>
    <div class="modal-actions">${onDelete ? `<button type="button" class="danger-button" id="modal-delete">${deleteLabel}</button>` : ""}<button type="button" class="secondary" id="modal-cancel">Cancel</button><button class="primary" type="submit">${submitLabel}</button></div></form>`);
  const form = $("#dynamic-form");
  const reviewerContent = $("textarea[name=content]", form);
  const wordCount = $(`[data-word-count]`, form);
  if (reviewerContent && wordCount) {
    const updateWordCount = () => {
      const words = reviewerContent.value.trim().split(/\s+/).filter(Boolean).length;
      wordCount.textContent = `${words} words · ${reviewerContent.value.length.toLocaleString()} / 20,000 characters`;
    };
    reviewerContent.addEventListener("input", updateWordCount);
    updateWordCount();
  }
  const finish = async (next) => {
    closeModal();
    try { await (typeof next === "function" ? next() : renderPage()); } catch (error) { toast(error.message); }
  };
  $("#modal-cancel").onclick = async () => { closeModal(); if (onCancel) await onCancel(); };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const button = $("[type=submit]", form);
    const label = button.innerHTML;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.innerHTML = `<span class="btn-spinner" aria-hidden="true"></span>${label}`;
    try { await finish(await onSubmit(Object.fromEntries(new FormData(form).entries()))); }
    catch (error) { $("#modal-error").textContent = error.message; button.disabled = false; button.innerHTML = label; button.removeAttribute("aria-busy"); }
  };
  const del = $("#modal-delete");
  if (del) del.onclick = async () => {
    if (confirmDelete && !confirm("Delete this? This can’t be undone.")) return;
    try { await finish(await onDelete()); } catch (error) { $("#modal-error").textContent = error.message; }
  };
  return form;
}
function field(label, name, placeholder = "", type = "text", value = "", attrs = "") {
  return `<label>${label}<input name="${name}" type="${type}" placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(value)}" ${attrs}></label>`;
}
function subjectSelect(subjects, selected = "") {
  return `<label>Subject (optional)<select name="subject_id"><option value="">No subject</option>${subjects.map((s) => `<option value="${s.id}" ${s.id === selected ? "selected" : ""}>${escapeHtml(s.name)}</option>`).join("")}</select></label>`;
}

// datetime-local expects a local wall-clock value, while task dates are stored as ISO UTC.
function toLocalInput(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

async function withButtonLoading(button, action) {
  if (!button || button.disabled) return;
  const original = button.innerHTML;
  const wasDisabled = button.disabled;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  button.classList.add("is-loading");
  button.innerHTML = `<span class="btn-spinner" aria-hidden="true"></span>${original}`;
  try { return await action(); }
  finally {
    button.innerHTML = original;
    button.disabled = wasDisabled;
    button.removeAttribute("aria-busy");
    button.classList.remove("is-loading");
  }
}

function openCreateClass() {
  modalForm({
    title: "Create a class",
    html: `${field("Class name", "name", "e.g. BSIT 2B – Silliman University 2026", "text", "", 'required maxlength="120"')}`,
    submitLabel: "Create class",
    onSubmit: async (d) => {
      const result = await api("/classes", { method: "POST", body: d });
      await selectClass(result.class.id);
      trackEvent("class_created");
      toast("Class created.");
    }
  });
}
function openJoinClass() {
  modalForm({
    title: "Join a class",
    html: `${field("Class code", "code", "ABC123", "text", "", 'required maxlength="8" autocapitalize="characters" autocomplete="off"')}`,
    submitLabel: "Join class",
    onSubmit: async (d) => {
      const result = await api("/classes/join", { method: "POST", body: { code: d.code } });
      await selectClass(result.class.id);
      trackEvent("class_joined");
      toast(result.alreadyMember ? "You’re already a member." : "You joined the class.");
    }
  });
}
function openEditClass() {
  const c = state.activeClass;
  modalForm({
    title: "Edit class",
    html: `${field("Class name", "name", "e.g. BSIT 2B – Silliman University 2026", "text", c.name, 'required maxlength="120"')}`,
    onSubmit: async (d) => {
      await api(`/classes/${c.id}`, { method: "PATCH", body: d });
      await loadClasses();
      toast("Class updated.");
    },
    onDelete: async () => () => openDeleteClassConfirm(),
    confirmDelete: false,
    deleteLabel: "Delete class"
  });
}
function openDeleteClassConfirm() {
  const c = state.activeClass;
  openModal("Delete class?", "DANGER ZONE", `<p class="muted">This permanently deletes <strong>${escapeHtml(c.name)}</strong> and everything in it. This can’t be undone.</p>
    <div class="modal-actions"><button type="button" class="secondary" id="delete-class-cancel">Cancel</button><button type="button" class="danger-button" id="delete-class-confirm">Delete class</button></div>`);
  $("#delete-class-cancel").onclick = () => openEditClass();
  $("#delete-class-confirm").onclick = async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await api(`/classes/${cid()}`, { method: "DELETE" });
      closeModal();
      await loadClasses();
      toast("Class deleted.");
      await renderPage();
    } catch (error) {
      button.disabled = false;
      toast(error.message);
    }
  };
}
async function openProfile() {
  const u = state.user;
    const avatarBlock = `<div class="profile-head">
        <div class="avatar-wrap"><button type="button" class="avatar-btn" id="avatar-open" aria-label="Change profile photo">${avatarHtml(u, "avatar-lg")}</button><button type="button" class="avatar-edit-fab" id="avatar-edit-fab" aria-label="Change profile photo">✎</button></div>
        <div class="profile-identity">
          ${field("Full name", "fullName", "", "text", u.fullName, 'required maxlength="100"')}
          ${field("Username", "username", "", "text", u.username, 'required minlength="3" maxlength="30" pattern="[A-Za-z0-9_]+"')}
          <p class="hint">Signed in as ${escapeHtml(u.email)}</p>
        </div>
      </div><input type="file" id="avatar-file" accept="image/*" hidden>`;
  openModal("Your profile", "ACCOUNT", `<form id="profile-form">${avatarBlock}
      <details class="profile-details"><summary>Change password</summary>
        <div class="profile-grid">
          <div>${field("Current password", "currentPassword", "", "password", "", 'autocomplete="current-password"')}</div>
          <div>${field("New password", "newPassword", "At least 8 characters", "password", "", 'minlength="8" maxlength="72" autocomplete="new-password"')}</div>
        </div>
      </details>
      <div class="profile-push"><span>Push notifications</span><label class="push-row"><input type="checkbox" id="push-toggle"> Enable</label></div>
      <div class="profile-push"><span>Active Status</span><label class="push-row"><input type="checkbox" name="activeStatus" ${u.activeStatus !== false ? "checked" : ""}> On</label></div>
      ${u.activeStatus === false ? '<p class="hint">Active Status is off. Other class members cannot see your status, and you cannot see theirs.</p>' : ''}
      <p class="hint" id="push-status">Classlie can notify you shortly before class and when your tasks become overdue.</p>
      <p class="form-error" id="profile-error"></p>
      <div class="modal-actions"><button type="button" class="danger-button" id="profile-logout">Sign out</button><button type="button" class="secondary" id="profile-close">Cancel</button><button class="primary" type="submit">Save</button></div></form>`);
  const form = $("#profile-form");
  $("#profile-close").onclick = closeModal;
  $("#profile-logout").onclick = () => { closeModal(); openLogoutConfirm(); };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const button = $("button[type=submit]", form);
    button.disabled = true;
    try {
      const d = Object.fromEntries(new FormData(form).entries());
      const body = {};
      if (d.fullName.trim() !== u.fullName) body.fullName = d.fullName;
      if (d.username.trim() !== u.username) body.username = d.username;
      const activeStatus = form.querySelector('[name="activeStatus"]').checked;
      if (activeStatus !== (u.activeStatus !== false)) body.activeStatus = activeStatus;
      if (d.newPassword && !d.currentPassword) throw new Error("Enter your current password to set a new one.");
      if (Object.keys(body).length) {
        const r = await api("/auth/me", { method: "PATCH", body });
        state.user = r.user; state.token = r.token; const rm=!!store.get(TOKEN_KEY); setToken(r.token, rm); setCachedUser(r.user, rm);
        renderUserChip();
      }
      if (d.newPassword) await api("/auth/password", { method: "POST", body: { currentPassword: d.currentPassword, newPassword: d.newPassword } });
      toast("Profile updated.");
      closeModal();
    } catch (error) {
      $("#profile-error").textContent = error.message;
      button.disabled = false;
      return;
    }
    button.disabled = false;
  };
  const logoutBtn = $("#profile-logout");
  if (logoutBtn) logoutBtn.onclick = () => { closeModal(); openLogoutConfirm(); };
  const fileInput = $("#avatar-file");
  const openPicker = () => { if (fileInput) fileInput.click(); };
  const avatarOpen = $("#avatar-open");
  const avatarFab = $("#avatar-edit-fab");
  if (avatarOpen) avatarOpen.onclick = openPicker;
  if (avatarFab) avatarFab.onclick = () => {
    closeModal();
    openModal("Profile photo", "PHOTO", `<div class="item-list">
      <button type="button" class="item-card" id="photo-change"><div class="item-main"><h3>Change photo</h3><p>Upload a new picture (JPG, PNG, GIF up to 1 MB)</p></div><span>→</span></button>
      ${u.avatarUrl ? `<button type="button" class="item-card" id="photo-remove"><div class="item-main"><h3>Remove photo</h3><p>Use default avatar</p></div><span>→</span></button>` : ""}
    </div>`);
    setTimeout(() => {
      $("#photo-change").onclick = () => { closeModal(); openPicker(); };
      const pr = $("#photo-remove");
      if (pr) pr.onclick = async () => {
        try {
          const r = await api("/auth/avatar", { method: "DELETE" });
          state.user = r.user;
          renderUserChip();
          closeModal();
          toast("Photo removed.");
          await openProfile();
        } catch (error) { toast(error.message); }
      };
    }, 0);
  };
  if (fileInput) fileInput.onchange = async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    if (file.size > 1024 * 1024) { toast("Your photo must be 1 MB or smaller."); return; }
    const fd = new FormData();
    fd.append("avatar", file);
    try {
      const r = await apiUpload("/auth/avatar", fd);
      state.user = r.user;
      renderUserChip();
      toast("Photo updated.");
      await openProfile();
    } catch (error) { toast(error.message); }
    fileInput.value = "";
  };
  wirePushToggle();
  return form;
}

/* ---------- web push opt-in ---------- */
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}
async function currentPushSubscription() {
  if (!("serviceWorker" in navigator) || !navigator.serviceWorker.ready) return null;
  const reg = await navigator.serviceWorker.ready;
  if (!reg.pushManager) return null;
  return reg.pushManager.getSubscription();
}
async function wirePushToggle() {
  const toggle = $("#push-toggle");
  const status = $("#push-status");
  if (!toggle) return;
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) { toggle.disabled = true; status.textContent = "Push isn't supported on this browser."; return; }
  let key;
  try { key = await api("/notifications/push/key"); } catch { key = { enabled: false }; }
  if (!key.enabled) { toggle.disabled = true; status.textContent = "Push notifications aren’t configured on this server yet."; return; }
  const existing = await currentPushSubscription();
  toggle.checked = !!existing;
  if (existing) {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    api("/notifications/push/subscribe", { method: "POST", body: { subscription: existing.toJSON(), timezone } }).catch(() => {});
  }
  status.textContent = existing ? "Notifications are enabled for upcoming classes and overdue tasks." : "Enable alerts for classes starting soon and overdue tasks.";
  toggle.onchange = async () => {
    toggle.disabled = true;
    try {
      if (toggle.checked) {
        const permission = await Notification.requestPermission();
        if (permission !== "granted") { toggle.checked = false; status.textContent = "Notifications are blocked in your browser settings."; return; }
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key.publicKey) });
        const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
        await api("/notifications/push/subscribe", { method: "POST", body: { subscription: sub.toJSON(), timezone } });
        trackEvent("push_enabled");
        status.textContent = "Notifications are enabled for upcoming classes and overdue tasks.";
        toast("Push notifications enabled.");
      } else {
        const sub = await currentPushSubscription();
        if (sub) { await api("/notifications/push/subscribe", { method: "DELETE", body: { endpoint: sub.endpoint } }); await sub.unsubscribe(); }
        status.textContent = "Push notifications are off.";
        toast("Push notifications disabled.");
      }
    } catch (error) {
      toggle.checked = !toggle.checked;
      status.textContent = error.message || "Couldn't update push notifications.";
    } finally {
      toggle.disabled = false;
    }
  };
}

const resourceLabels = { subjects: "subject", tasks: "task", schedules: "schedule" };
async function openItemForm(resource, item = null, prefill = null) {
  const subjects = resource === "tasks" || resource === "schedules" ? await fetchResource("subjects") : [];
  const edit = !!item;
  const data = item || prefill || {};
  let html = "";
  if (resource === "subjects") html = `${field("Subject name", "name", "e.g. Data Structures", "text", data.name || "", 'required maxlength="120"')}<label>Card color<input name="color" type="color" value="${escapeHtml(data.color || colors[0])}"></label>`;
  if (resource === "tasks") {
    const privateDefault = data.is_private ?? !isAdmin();
    const privateField = edit
      ? (item.is_private ? `<p class="hint">🔒 This is a private task — only you can see it.</p>` : "")
      : (isAdmin()
        ? `<label class="check-row"><input type="checkbox" name="is_private" ${privateDefault ? "checked" : ""}> Private — only visible to me</label>`
        : `<p class="hint">🔒 Personal task — only you can see it.</p>`);
    const repeatField = edit ? "" : `<label>Repeat<select name="repeat"><option value="none">None</option><option value="weekly">Weekly (15 weeks)</option><option value="biweekly">Bi-weekly (8 times)</option><option value="monthly">Monthly (4 times)</option></select></label>`;
    html = `${field("Task title", "title", "e.g. Module 3 activity", "text", data.title || "", 'required maxlength="180"')}<label>Description<textarea name="description" maxlength="5000" placeholder="Instructions or details">${escapeHtml(data.description || "")}</textarea></label>${subjectSelect(subjects, data.subject_id || "")}
    <div class="two-col">${field("Due date & time", "due_at", "", "datetime-local", toLocalInput(data.due_at))}<label>Priority<select name="priority">${["low", "normal", "high"].map((p) => `<option value="${p}" ${(data.priority || "normal") === p ? "selected" : ""}>${p[0].toUpperCase() + p.slice(1)}</option>`).join("")}</select></label></div>${repeatField}${privateField}`;
  }
  const dateToday = localDateStr(new Date());
  if (resource === "schedules") html = `${field("Schedule title", "title", "e.g. Object-Oriented Programming", "text", data.title || "", 'required maxlength="160"')}${subjectSelect(subjects, data.subject_id || "")}
    <label>Day<select name="day_of_week">${days.map((d, i) => `<option value="${i}" ${Number(data.day_of_week ?? new Date().getDay()) === i ? "selected" : ""}>${d}</option>`).join("")}</select></label>
    <div class="two-col">${field("Start time", "start_time", "", "time", (data.start_time || "08:00").slice(0, 5), 'required step="900"')}${field("End time", "end_time", "", "time", (data.end_time || "09:00").slice(0, 5), 'required step="900"')}</div>
    <p class="hint" id="duration-hint"></p>${field("Room", "room", "e.g. Lab 2", "text", data.room || "", 'maxlength="100"')}${!edit ? `<label class="check-row"><input type="checkbox" name="temporary" id="schedule-temporary"> Temporary schedule</label><div id="schedule-temporary-fields" hidden>${field("Schedule label", "temporary_title", "e.g. Exam Week", "text", "", 'maxlength="120"')}<div class="two-col">${field("Start date", "start_date", "", "date", dateToday)}${field("End date", "end_date", "", "date", dateToday)}</div>${field("Entry date", "entry_date", "", "date", dateToday)}</div>` : ""}`;

  const form = modalForm({
    title: (edit ? "Edit " : "Add ") + resourceLabels[resource],
    html,
    onSubmit: async (d) => {
      if (resource === "schedules") {
        d.day_of_week = Number(d.day_of_week);
        if (toMinutes(d.end_time) <= toMinutes(d.start_time)) throw new Error("End time must be later than start time.");
        if (d.temporary) {
          if (!d.temporary_title || !d.start_date || !d.end_date || !d.entry_date) throw new Error("Fill in the temporary schedule label and dates.");
          if (d.end_date < d.start_date || d.entry_date < d.start_date || d.entry_date > d.end_date) throw new Error("Entry date must fall within the temporary schedule dates.");
          const subject = subjects.find((item) => item.id === d.subject_id)?.name || "";
          await api(`/class-data/${cid()}/temporary-schedules`, { method: "POST", body: { title: d.temporary_title, start_date: d.start_date, end_date: d.end_date, entries: [{ title: d.title, subject, entry_date: d.entry_date, start_time: d.start_time, end_time: d.end_time, room: d.room }] } });
          toast("Temporary schedule saved.");
          return;
        }
      }
      if (resource === "tasks") {
        const dt = d.due_at ? new Date(d.due_at) : null;
        d.due_at = dt && !Number.isNaN(dt.getTime()) ? dt.toISOString() : null;
        const isPrivate = edit ? !!item.is_private : (isAdmin() ? $("#dynamic-form [name=is_private]").checked : true);
        const base = isPrivate ? `/class-data/${cid()}/tasks/private` : `/class-data/${cid()}/tasks`;
        const result = await api(`${base}${edit ? "/" + item.id : ""}`, { method: edit ? "PATCH" : "POST", body: d });
        if (!edit) trackEvent("item_created", { resource });
        toast(edit ? "Changes saved." : result.created_count > 1 ? `Added ${result.created_count} recurring tasks.` : "Added successfully.");
        return;
      }
      await api(`/class-data/${cid()}/${resource}${edit ? "/" + item.id : ""}`, { method: edit ? "PATCH" : "POST", body: d });
      if (!edit) trackEvent("item_created", { resource });
      toast(edit ? "Changes saved." : "Added successfully.");
    },
    onDelete: edit ? async () => {
      const url = resource === "tasks" && item.is_private
        ? `/class-data/${cid()}/tasks/private/${item.id}`
        : `/class-data/${cid()}/${resource}/${item.id}`;
      await api(url, { method: "DELETE" });
      toast("Deleted.");
    } : undefined,
    deleteLabel: resource === "subjects" ? "Delete subject and its topics" : "Delete"
  });
  if (resource === "schedules") {
    wireTimePicker(form);
    const toggle = $("#schedule-temporary", form);
    if (toggle) toggle.onchange = () => { $("#schedule-temporary-fields", form).hidden = !toggle.checked; };
  }
}
// Moving the start time keeps the same duration; the hint shows the duration or the validation problem.
function wireTimePicker(form) {
  const start = form.elements.start_time, end = form.elements.end_time, hint = $("#duration-hint");
  let lastStart = toMinutes(start.value);
  const update = () => {
    const s = toMinutes(start.value), e = toMinutes(end.value);
    if (s === null || e === null) { hint.textContent = ""; return; }
    hint.classList.toggle("bad", e <= s);
    hint.textContent = e <= s ? "End time must be later than start time." : `Duration: ${fmtDuration(e - s)}`;
  };
  start.addEventListener("input", () => {
    const s = toMinutes(start.value), e = toMinutes(end.value);
    if (s !== null && lastStart !== null && e !== null && e - lastStart > 0) end.value = fromMinutes(s + (e - lastStart));
    if (s !== null) lastStart = s;
    update();
  });
  end.addEventListener("input", update);
  update();
}

/* ---------- uploads ---------- */
// The file route needs the Bearer token, so a plain <a href> would 401. Fetch it, then save the blob.
async function downloadUpload(id, filename) {
  const headers = {};
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  let response;
  try {
    response = await fetch(`/api/uploads/${cid()}/${id}/file`, { headers });
  } catch {
    throw new Error("Can't reach the server. Check your connection and try again.");
  }
  if (response.status === 401 && state.token) { logout(false); throw new Error("Please sign in again."); }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || "Could not download that file.");
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename || "download";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function openUploadForm(subjectId = "", subjectName = "") {
  const subjects = await fetchResource("subjects");
  modalForm({
    title: "Upload a file",
    eyebrow: subjectName ? subjectName.toUpperCase() : "REVIEWERS",
    html: `${field("Title", "title", "e.g. Chapter 3 reviewer", "text", "", 'required maxlength="180"')}
      <label>Notes (optional)<textarea name="content" maxlength="20000" placeholder="Type or paste a note…"></textarea></label>
      ${subjectSelect(subjects, subjectId)}
      <label>Attach a file (optional, up to 5 MB)<input name="file" type="file"></label>
      <p class="hint">Formatting: **bold**, *italic*, - bullet list, [text](https://link).</p>`,
    submitLabel: "Upload",
    onCancel: subjectId ? () => openSubject(subjectId).catch(() => {}) : undefined,
    onSubmit: async () => {
      const fd = new FormData();
      fd.set("title", $("#dynamic-form [name=title]").value);
      fd.set("content", $("#dynamic-form [name=content]").value);
      fd.set("subject_id", $("#dynamic-form [name=subject_id]").value || "");
      const file = $("#dynamic-form [name=file]").files[0];
      if (file) fd.set("file", file);
      await apiUpload(`/uploads/${cid()}`, fd);
      toast("Note uploaded.");
      return subjectId ? () => openSubject(subjectId).catch(() => {}) : undefined;
    }
  });
}

/* ---------- attendance ---------- */
async function openAttendanceForm(session = null) {
  const subjects = await fetchResource("subjects");
  const kind = session?.kind || "weekly";
  const chosen = new Set((session?.days || []).map(Number));
  const dayChecks = days.map((d, i) =>
    `<label class="day-check"><input type="checkbox" name="days" value="${i}" ${chosen.has(i) ? "checked" : ""}> ${d}</label>`).join("");
  modalForm({
    title: (session ? "Edit" : "Add") + " attendance session",
    eyebrow: "ATTENDANCE",
    html: `${field("Session name", "name", "e.g. Flag ceremony or Programming 2", "text", session?.name || "", 'required maxlength="160"')}
      ${subjectSelect(subjects, session?.subject_id || "")}
      <label>Repeats<select name="kind"><option value="weekly" ${kind === "weekly" ? "selected" : ""}>Every week</option><option value="date" ${kind === "date" ? "selected" : ""}>One date only</option></select></label>
      <div><span class="hint">Days it happens (for weekly)</span><div class="day-checks">${dayChecks}</div></div>
      ${field("Date (for a one-off)", "event_date", "", "date", session?.event_date ? String(session.event_date).slice(0, 10) : "")}
      <div class="two-col">${field("Start time (optional)", "start_time", "", "time", (session?.start_time || "").slice(0, 5))}${field("End time (optional)", "end_time", "", "time", (session?.end_time || "").slice(0, 5))}</div>`,
    submitLabel: session ? "Save session" : "Add session",
    onSubmit: async (d) => {
      const body = {
        name: d.name,
        subject_id: d.subject_id || null,
        kind: d.kind,
        start_time: d.start_time || null,
        end_time: d.end_time || null
      };
      if (d.kind === "weekly") body.days = $$("#dynamic-form input[name=days]:checked").map((el) => Number(el.value));
      else body.event_date = d.event_date;
      await api(`/attendance/${cid()}/sessions${session ? "/" + session.id : ""}`, { method: session ? "PATCH" : "POST", body });
      toast(session ? "Session updated." : "Session added.");
    },
    onDelete: session ? async () => {
      await api(`/attendance/${cid()}/sessions/${session.id}`, { method: "DELETE" });
      toast("Session deleted.");
    } : undefined,
    deleteLabel: "Delete session"
  });
}
async function openTakeAttendance(sessionId, date = null) {
  let day = date;
  const render = async () => {
    const data = await api(`/attendance/${cid()}/sessions/${sessionId}?date=${day}`);
    const { session, members, occurs, canMark } = data;
    // New attendance starts as present; saved statuses remain selected when reopening a date.
    const attendanceState = new Map(members.map((member) => [member.id, member.status || "present"]));
    const sortedMembers = [...members].sort((a, b) =>
      String(a.full_name || a.username || "").localeCompare(String(b.full_name || b.username || ""), undefined, { sensitivity: "base" })
    );
    const disabled = !canMark || !occurs ? "disabled" : "";
    const rowHtml = (member) => {
      const status = attendanceState.get(member.id);
      const name = member.full_name || member.username || "";
      return `<div class="att-row att-row-toggle${status === "absent" ? " is-absent" : ""}" data-att-row data-att-user="${member.id}" data-att-name="${escapeHtml(`${name} ${member.username || ""}`.toLowerCase())}">
        <div class="att-row-info"><strong>${escapeHtml(name)}</strong><small class="muted">@${escapeHtml(member.username || "")}</small></div>
        <div class="att-toggle-group" role="group" aria-label="Attendance for ${escapeHtml(name)}">
          <button type="button" class="att-toggle ${status !== "absent" ? "active present" : ""}" aria-pressed="${status !== "absent"}" data-att-status="present" ${disabled}>Present</button>
          <button type="button" class="att-toggle ${status === "absent" ? "active absent" : ""}" aria-pressed="${status === "absent"}" data-att-status="absent" ${disabled}>Absent</button>
        </div>
      </div>`;
    };
    const searchHtml = members.length ? `<label class="att-search"><span class="sr-only">Search members</span><input type="search" id="att-member-search" placeholder="Search students…" autocomplete="off"></label>` : "";
    const bulkHtml = canMark && occurs ? `<div class="att-bulk att-bulk-v2" role="group" aria-label="Set everyone’s attendance"><button type="button" class="small-link" data-att-bulk-all="present">Mark All Present</button><button type="button" class="small-link" data-att-bulk-all="absent">Mark All Absent</button></div>` : "";
    openModal(session.name, "TAKE ATTENDANCE",
      `<div class="att-modal-toolbar">
        <label class="att-date-field">Date<input type="date" id="att-date" value="${day}"></label>
        ${searchHtml}
        <div class="att-live-counts" role="status" aria-live="polite"><span>Total: <strong id="att-total-count">0</strong></span><i></i><span>Present: <strong class="green-t" id="att-present-count">0</strong></span><i></i><span>Absent: <strong class="red-t" id="att-absent-count">0</strong></span></div>
        ${bulkHtml}
      </div>
      ${occurs ? "" : `<div class="callout">This session doesn’t normally happen on this date, so nothing can be saved.</div>`}
      <div class="att-list att-list-v2" id="att-roster">${sortedMembers.map(rowHtml).join("") || emptyState("No students in this class", "There are no members to mark for this session.")}</div>
      ${canMark && occurs ? `<div class="modal-actions att-save-actions"><button type="button" class="secondary" id="att-cancel">Cancel</button><button type="button" class="primary" id="att-save">Save attendance</button></div>` : `<div class="modal-actions att-save-actions"><button type="button" class="secondary" id="att-cancel">Close</button></div>`}`);

    const updateCounts = () => {
      const total = attendanceState.size;
      const absent = [...attendanceState.values()].filter((status) => status === "absent").length;
      $("#att-total-count").textContent = total;
      $("#att-present-count").textContent = total - absent;
      $("#att-absent-count").textContent = absent;
    };
    const setStatus = (row, status) => {
      const userId = row.dataset.attUser;
      attendanceState.set(userId, status);
      row.classList.toggle("is-absent", status === "absent");
      $$(".att-toggle", row).forEach((button) => {
        const active = button.dataset.attStatus === status;
        button.classList.toggle("active", active);
        button.classList.toggle("present", active && status === "present");
        button.classList.toggle("absent", active && status === "absent");
        button.setAttribute("aria-pressed", String(active));
      });
      updateCounts();
    };
    updateCounts();

    const search = $("#att-member-search");
    if (search) search.addEventListener("input", () => {
      const query = search.value.trim().toLowerCase();
      $$('[data-att-row]', $("#att-roster")).forEach((row) => row.classList.toggle("hidden", query && !row.dataset.attName.includes(query)));
    });
    $$(".att-toggle", $("#att-roster")).forEach((button) => button.addEventListener("click", () => {
      if (!button.disabled) setStatus(button.closest("[data-att-row]"), button.dataset.attStatus);
    }));
    $$('[data-att-bulk-all]', $("#modal-body")).forEach((button) => button.addEventListener("click", () => {
      $$("[data-att-row]", $("#att-roster")).forEach((row) => setStatus(row, button.dataset.attBulkAll));
    }));
    $("#att-date").addEventListener("change", (event) => { day = event.target.value; render().catch((error) => toast(error.message)); });
    $("#att-cancel").addEventListener("click", closeModal);
    const save = $("#att-save");
    if (save) save.addEventListener("click", async () => {
      const records = [...attendanceState].map(([userId, status]) => ({ userId, status }));
      save.disabled = true;
      try {
        await api(`/attendance/${cid()}/sessions/${sessionId}/records`, { method: "PUT", body: { date: day, records } });
        closeModal();
        toast("Attendance saved.");
        await renderPage();
      } catch (error) { toast(error.message); save.disabled = false; }
    });
  };
  if (!day) {
    const { sessions } = await api(`/attendance/${cid()}/sessions`);
    const session = sessions.find((item) => item.id === sessionId);
    day = session ? nextOccurrence(session) : localDateStr();
  }
  await render();
}

/* ---------- subjects → topics → reviewer notes ---------- */
/* ---------- subjects: one combined list of reviewers per subject ---------- */
function reviewerCard(r) {
  const badge = r.source === "ai" ? '<span class="pill ai-pill">✦ AI</span>' : "";
  const icon = r.kind === "upload" ? (r.file_name ? "⇪" : "✎") : "▤";
  const canDelete = r.kind === "note" ? isAdmin() : (r.user_id === state.user.id || isAdmin());
  const del = canDelete
    ? `<button type="button" class="small-link link-danger" data-reviewer-action data-${r.kind === "note" ? "note" : "upload"}-delete="${r.id}">Delete</button>`
    : "";
  const file = r.file_name ? ` · ${escapeHtml(r.file_name)}` : "";
  return `<article class="item-card reviewer-card" data-reviewer-open="${r.kind}:${r.id}">
    <div class="class-avatar">${icon}</div>
    <div class="item-main"><h3>${escapeHtml(r.title)} ${badge}</h3>
      <div class="item-meta">by ${escapeHtml(r.full_name || r.username)} · ${escapeHtml(fmtDate(r.created_at))}${file}</div></div>
    <div class="reviewer-card-actions">${del}<span class="reviewer-arrow">→</span></div>
  </article>`;
}

function quizCard(q) {
  const canDelete = q.created_by === state.user.id || isAdmin();
  const score = q.my_last ? `Last ${q.my_last.score}/${q.my_last.total}` : "Not taken yet";
  const best = q.my_best !== null && q.my_best !== undefined ? ` · best ${q.my_best}/${q.question_count}` : "";
  const attempts = q.my_attempts ? ` · ${q.my_attempts} attempt${q.my_attempts === 1 ? "" : "s"}` : "";
  const dueBadge = q.due_review_count ? `<span class="pill quiz-review-due">${q.due_review_count} due to review</span>` : "";
  return `<article class="item-card quiz-card"><div class="class-avatar">▤</div><div class="item-main quiz-card-main">
    <h3 class="quiz-card-title">${escapeHtml(q.title)} <span class="pill">${escapeHtml(q.difficulty)}</span> ${dueBadge}</h3>
    <p class="quiz-card-details">${q.question_count} question${q.question_count === 1 ? "" : "s"}${q.subject_name ? ` · ${escapeHtml(q.subject_name)}` : ""}</p>
    <div class="item-meta quiz-card-meta">${score}${best}${attempts} · by ${escapeHtml(q.full_name || q.username)}</div>
    <div class="inline-actions quiz-card-actions"><button class="secondary" data-quiz-open="${q.id}">${q.my_last ? "Retake" : "Start quiz"}</button>${canDelete ? `<button class="small-link link-danger" data-quiz-delete="${q.id}">Delete</button>` : ""}</div>
  </div></article>`;
}

// Quizzes live under a subject too — pick a subject, see all of its quizzes.
async function openSubject(subjectId, tab = "reviewers") {
  const subject = state.cache.subjects?.find((s) => s.id === subjectId);
  const subjectName = subject?.name || "Subject";
  openWideModal(subjectName, "SUBJECT", '<div class="modal-skeleton" aria-label="Loading subject"><span class="skeleton-line"></span><span class="skeleton-line"></span><span class="skeleton-line"></span></div>');
  const [{ reviewers }, { quizzes }, tasks] = await Promise.all([
    api(`/class-data/${cid()}/subjects/${subjectId}/reviewers`),
    api(`/ai/${cid()}/quizzes`),
    fetchResource("tasks")
  ]);
  const subjectQuizzes = quizzes.filter((q) => q.subject_id === subjectId);
  const subjectTasks = tasks.filter((t) => t.subject_id === subjectId);
  const isQuizzes = tab === "quizzes";
  const isTasks = tab === "tasks";
  const toolbar = isQuizzes
    ? `<button type="button" class="primary" id="study-quiz-btn">✦ Quiz</button>`
    : isTasks
      ? `<button type="button" class="primary" data-subject-add-task>＋ Add task</button>`
      : `<button type="button" class="primary" id="add-reviewer-btn">＋ Add reviewer</button>
       <button type="button" class="secondary" id="upload-reviewer-btn">⇪ Upload file</button>
       <button type="button" class="secondary" id="ai-reviewer-btn">✦ AI reviewer</button>`;
  const tabs = `<div class="subject-tabs">
    <button type="button" class="${!isQuizzes && !isTasks ? "active" : ""}" data-subject-tab="reviewers">Reviewers <span class="pill">${reviewers.length}</span></button>
    <button type="button" class="${isQuizzes ? "active" : ""}" data-subject-tab="quizzes">Quizzes <span class="pill">${subjectQuizzes.length}</span></button>
    <button type="button" class="${isTasks ? "active" : ""}" data-subject-tab="tasks">Tasks <span class="pill">${subjectTasks.length}</span></button>
  </div>`;
  const reviewersPanel = `${reviewers.length > 6 ? `<label class="reviewer-filter"><input type="search" id="reviewer-filter" placeholder="Filter reviewers…" autocomplete="off"></label>` : ""}
    <div class="item-list" id="reviewer-list">${reviewers.map(reviewerCard).join("") || emptyState("No reviewers yet", "Add a reviewer, upload a file, or let AI draft one from a slide deck.")}</div>`;
  const quizzesPanel = `<div class="item-list subject-quiz-list">${subjectQuizzes.length ? subjectQuizzes.map(quizCard).join("") : emptyState("No quizzes yet", "Tap ✦ Quiz to build a multiple-choice quiz from this subject's reviewers.")}</div>`;
  const tasksPanel = `<div class="item-list">${subjectTasks.length ? subjectTasks.map((t) => taskCard(t)).join("") : emptyState("No tasks yet", "Add a task for this subject, or a private one only you can see.")}</div>`;
  openWideModal(subjectName, "SUBJECT", `
    <div class="inline-actions reviewer-toolbar subject-toolbar">${toolbar}</div>
    ${tabs}
    <div id="subject-panel">${isQuizzes ? quizzesPanel : isTasks ? tasksPanel : reviewersPanel}</div>`);
  const body = $("#modal-body");
  let swipeStart = null;
  body.addEventListener("pointerdown", (event) => {
    if (event.target.closest("button,a,input,textarea,select")) { swipeStart = null; return; }
    swipeStart = { x: event.clientX, y: event.clientY };
  }, { passive: true });
  body.addEventListener("pointerup", (event) => {
    if (!swipeStart) return;
    const dx = event.clientX - swipeStart.x, dy = event.clientY - swipeStart.y;
    swipeStart = null;
    if (Math.abs(dx) <= 50 || Math.abs(dx) <= Math.abs(dy) * 1.3) return;
    const tabs = ["reviewers", "quizzes", "tasks"];
    const next = tabs[Math.max(0, Math.min(tabs.length - 1, tabs.indexOf(tab) + (dx < 0 ? 1 : -1)))];
    if (next !== tab) openSubject(subjectId, next);
  }, { passive: true });
  const again = () => openSubject(subjectId, tab);
  $$("[data-subject-tab]", body).forEach((b) => b.addEventListener("click", () => { if (b.dataset.subjectTab !== tab) openSubject(subjectId, b.dataset.subjectTab); }));
  if (isQuizzes) {
    $("#study-quiz-btn").onclick = () => openQuizBuilder({ subjectIds: [subjectId], subjectName }).catch((e) => toast(e.message));
    $$("[data-quiz-open]", body).forEach((el) => el.addEventListener("click", () => openQuiz(el.dataset.quizOpen).catch((e) => toast(e.message))));
    $$("[data-quiz-delete]", body).forEach((el) => el.addEventListener("click", async () => {
      if (!confirm("Delete this quiz and all of its attempts?")) return;
      try { await api(`/ai/${cid()}/quizzes/${el.dataset.quizDelete}`, { method: "DELETE" }); toast("Quiz deleted."); await again(); } catch (e) { toast(e.message); }
    }));
    return;
  }
  if (isTasks) {
    $("[data-subject-add-task]", body).onclick = () => openItemForm("tasks", null, { subject_id: subjectId, is_private: !isAdmin() }).catch((e) => toast(e.message));
    $$("[data-action]", $("#subject-panel")).forEach((el) => el.addEventListener("click", async (e) => {
      e.stopPropagation();
      try { await handleAction(el.dataset.action, el); } catch (err) { toast(err.message); }
    }));
    wireTaskToggles($("#subject-panel"));
    return;
  }
  $("#add-reviewer-btn").onclick = () => openReviewerForm(subjectId, subjectName);
  $("#upload-reviewer-btn").onclick = () => openUploadForm(subjectId, subjectName);
  $("#ai-reviewer-btn").onclick = () => openReviewerGenerator({ subjectId, subjectName });
  $$("[data-reviewer-open]", body).forEach((card) => card.addEventListener("click", (e) => {
    if (e.target.closest("[data-reviewer-action]")) return;
    const r = reviewers.find((x) => `${x.kind}:${x.id}` === card.dataset.reviewerOpen);
    if (r) openReviewer(r, subjectId, subjectName, reviewers);
  }));
  $$("[data-note-delete]", body).forEach((b) => b.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!confirm("Delete this reviewer?")) return;
    try { await api(`/class-data/${cid()}/notes/${b.dataset.noteDelete}`, { method: "DELETE" }); toast("Reviewer deleted."); await again(); } catch (err) { toast(err.message); }
  }));
  $$("[data-upload-delete]", body).forEach((b) => b.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!confirm("Delete this file?")) return;
    try { await api(`/uploads/${cid()}/${b.dataset.uploadDelete}`, { method: "DELETE" }); toast("File deleted."); await again(); } catch (err) { toast(err.message); }
  }));
  const filter = $("#reviewer-filter");
  if (filter) filter.addEventListener("input", () => {
    const q = filter.value.trim().toLowerCase();
    $$(".reviewer-card", body).forEach((card) => { card.style.display = !q || card.textContent.toLowerCase().includes(q) ? "" : "none"; });
  });
}

// A reviewer opens as its own reading view, with copy / download for studying offline.
function openReviewer(r, subjectId, subjectName, reviewers = []) {
  const canEdit = r.kind === "note" && isAdmin();
  const fileButton = r.file_name
    ? `<button type="button" class="secondary" id="reviewer-file" data-name="${escapeHtml(r.file_name)}">⇩ ${escapeHtml(r.file_name)}</button>`
    : "";
  openWideModal(r.title, r.source === "ai" ? "AI REVIEWER" : "REVIEWER", `
    <div class="item-meta reviewer-view-meta">by ${escapeHtml(r.full_name || r.username)} · ${escapeHtml(fmtDate(r.created_at))}${r.source === "ai" ? ' · <span class="pill ai-pill">✦ AI</span>' : ""}${subjectName ? ` · ${escapeHtml(subjectName)}` : ""}</div>
    ${r.content ? `<div class="note-content reviewer-view">${renderMarkdown(r.content)}</div>` : `<p class="muted">No text in this reviewer — open the attached file.</p>`}
    <div class="modal-actions reviewer-actions">
      <button type="button" class="secondary" id="reviewer-back">← Back</button>
      ${r.content ? `<button type="button" class="secondary" id="reviewer-copy">Copy text</button>` : ""}
      ${canEdit ? `<button type="button" class="secondary" id="reviewer-edit">Edit</button>` : ""}
      ${fileButton}
    </div>`);
  $("#reviewer-back").onclick = () => openSubject(subjectId).catch((e) => toast(e.message));
  $("#reviewer-copy")?.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(r.content); toast("Reviewer copied."); } catch { toast("Couldn't copy automatically."); }
  });
  $("#reviewer-file")?.addEventListener("click", (e) => downloadUpload(r.id, e.currentTarget.dataset.name).catch((err) => toast(err.message)));
  $("#reviewer-edit")?.addEventListener("click", () => openNoteEditor(r, subjectId, subjectName));
  const at = reviewers.findIndex((item) => item.kind === r.kind && item.id === r.id);
  wireSwipe($("#modal-body"), () => { if (at >= 0 && at < reviewers.length - 1) openReviewer(reviewers[at + 1], subjectId, subjectName, reviewers); }, () => { if (at > 0) openReviewer(reviewers[at - 1], subjectId, subjectName, reviewers); });
}

// Everyone can add a reviewer: admins create a class note, students keep it as their own note.
function openReviewerForm(subjectId, subjectName) {
  modalForm({
    title: "Add reviewer",
    eyebrow: subjectName ? subjectName.toUpperCase() : "REVIEWER",
    submitLabel: "Save reviewer",
    html: `${field("Title", "title", "e.g. Key concepts", "text", "", 'required maxlength="180"')}
      <label>Content<textarea name="content" maxlength="20000" placeholder="Write or paste your reviewer…"></textarea><small class="word-count" data-word-count></small></label>
      <p class="hint">Formatting: **bold**, *italic*, \`code\`, # heading, - bullet list, [text](https://link).</p>`,
    onSubmit: async (d) => {
      if (isAdmin()) {
        await api(`/class-data/${cid()}/subjects/${subjectId}/notes`, { method: "POST", body: d });
      } else {
        const fd = new FormData();
        fd.set("title", d.title); fd.set("content", d.content); fd.set("subject_id", subjectId);
        await apiUpload(`/uploads/${cid()}`, fd);
      }
      toast("Reviewer saved.");
      return () => openSubject(subjectId).catch(() => {});
    }
  });
}

function openNoteEditor(note, subjectId, subjectName) {
  modalForm({
    title: "Edit reviewer",
    eyebrow: subjectName ? subjectName.toUpperCase() : "REVIEWER",
    submitLabel: "Save changes",
    html: `${field("Title", "title", "", "text", note.title, 'required maxlength="180"')}
      <label>Content<textarea name="content" maxlength="20000">${escapeHtml(note.content || "")}</textarea><small class="word-count" data-word-count></small></label>
      <p class="hint">Formatting: **bold**, *italic*, \`code\`, # heading, - bullet list, [text](https://link).</p>`,
    onSubmit: async (d) => {
      await api(`/class-data/${cid()}/notes/${note.id}`, { method: "PATCH", body: d });
      toast("Reviewer updated.");
      return () => openSubject(subjectId).catch(() => {});
    },
    onDelete: async () => {
      await api(`/class-data/${cid()}/notes/${note.id}`, { method: "DELETE" });
      toast("Reviewer deleted.");
    },
    deleteLabel: "Delete reviewer"
  });
}


/* ---------- AI study tools (reviewers and quizzes) ---------- */

function aiSubjectOptions(subjects, selectedId = "", placeholder = "Select a subject…") {
  return `<option value="">${escapeHtml(placeholder)}</option>${subjects.map((s) => `<option value="${s.id}" ${s.id === selectedId ? "selected" : ""}>${escapeHtml(s.name)}</option>`).join("")}`;
}

/* ---- generate a reviewer from a file or pasted text, saved into a subject ---- */
async function openReviewerGenerator(prefill = {}) {
  const subjects = await fetchResource("subjects");
  if (!subjects.length) {
    toast("Create a subject first so the reviewer has a home.");
    return;
  }
  openWideModal("AI reviewer", "AI NOTES", `
    <p class="muted">Upload a PowerPoint, PDF, image or text file and AI drafts a compact reviewer. It is saved straight into the subject you pick.</p>
    <div class="ai-form">
      <label>Save under subject<select id="rv-subject">${aiSubjectOptions(subjects, prefill.subjectId)}</select></label>
      <label>Source file<small class="muted block">PPTX, PDF, PNG/JPG, TXT/MD · up to 10 MB</small><input type="file" id="rv-file" accept=".pptx,.pdf,.txt,.md,.markdown,.csv,image/*"></label>
      <p class="form-error" id="rv-error"></p>
      <div class="modal-actions"><button type="button" class="secondary" id="rv-cancel">Cancel</button><button type="button" class="primary" id="rv-go">✦ Generate reviewer</button></div>
    </div>`);
  const subjectSel = $("#rv-subject");
  $("#rv-cancel").onclick = () => { closeModal(); if (prefill.subjectId) openSubject(prefill.subjectId).catch(() => {}); };
  $("#rv-go").onclick = async () => {
    const file = $("#rv-file").files[0];
    if (!subjectSel.value) return ($("#rv-error").textContent = "Pick a subject to save the reviewer under.");
    if (!file) return ($("#rv-error").textContent = "Choose a file first.");
    const button = $("#rv-go"); button.disabled = true; const label = button.textContent; button.textContent = "✦ Generating…";
    $("#rv-error").textContent = "";
    try {
      const form = new FormData();
      if (file) form.append("file", file);
      form.append("subject_id", subjectSel.value);
      const subjectName = subjects.find((s) => s.id === subjectSel.value)?.name;
      const { reviewer, source } = await apiForm(`/ai/${cid()}/reviewers/generate`, form);
      trackEvent("ai_used", { tool: "reviewer" });
      showReviewerPreview(reviewer, { subjectId: subjectSel.value, subjectName, source });
    } catch (error) {
      $("#rv-error").textContent = error.message; button.disabled = false; button.textContent = label;
    }
  };
}

function showReviewerPreview(reviewer, meta) {
  openWideModal("Review before saving", "AI REVIEWER", `
    ${meta.source ? `<p class="hint">Read from <strong>${escapeHtml(meta.source.fileName || "material")}</strong>${meta.source.chars ? ` · ${meta.source.chars.toLocaleString()} characters of text` : ""}.</p>` : ""}
    <div class="ai-form">
      <label>Title<input id="rv-title" maxlength="180" value="${escapeHtml(reviewer.title)}"></label>
      <label>Reviewer (markdown — edit freely)<textarea id="rv-content" class="ai-editor" maxlength="20000">${escapeHtml(reviewer.content)}</textarea></label>
      <div class="section-title" style="margin:14px 0 6px"><h3 class="sub">Live preview</h3></div>
      <div class="preview-box note-content" id="rv-preview">${renderMarkdown(reviewer.content)}</div>
      <p class="form-error" id="rv-error"></p>
      <p class="hint">Saving into <strong>${escapeHtml(meta.subjectName || "the subject")}</strong>.</p>
      <div class="modal-actions"><button type="button" class="secondary" id="rv-back">← Back</button><button type="button" class="primary" id="rv-save">Save reviewer</button></div>
    </div>`);
  const content = $("#rv-content"), preview = $("#rv-preview");
  content.oninput = () => { preview.innerHTML = renderMarkdown(content.value); };
  $("#rv-back").onclick = () => openReviewerGenerator({ subjectId: meta.subjectId, subjectName: meta.subjectName });
  $("#rv-save").onclick = async () => {
    const button = $("#rv-save"); button.disabled = true; button.textContent = "Saving…";
    try {
      const result = await api(`/ai/${cid()}/reviewers/save`, { method: "POST", body: { title: $("#rv-title").value.trim(), content: content.value.trim(), subject_id: meta.subjectId } });
      toast(result.kind === "note" ? "Reviewer saved to the subject." : "Reviewer saved to the subject.");
      closeModal();
      await openSubject(meta.subjectId).catch(() => {});
    } catch (error) { $("#rv-error").textContent = error.message; button.disabled = false; button.textContent = "Save reviewer"; }
  };
}

/* ---- build a quiz from the reviewers of one or more subjects ---- */
async function openQuizBuilder(prefill = {}) {
  openWideModal("Build a Quiz", "REVIEWERS", '<div class="modal-skeleton" aria-label="Loading reviewers"><span class="skeleton-line"></span><span class="skeleton-line"></span><span class="skeleton-line"></span></div>');
  try {
    const subjects = await fetchResource("subjects");
    const tree = await Promise.all(subjects.map(async (subject) => {
      const [notes, uploads] = await Promise.all([
        api(`/class-data/${cid()}/subjects/${subject.id}/notes`),
        api(`/uploads/${cid()}?subject_id=${subject.id}`)
      ]);
      return { subject, reviewers: [...(notes.notes || []), ...(uploads.uploads || [])] };
    }));
    const preselected = new Set(prefill.reviewerIds || []);
    const html = tree.map(({ subject, reviewers }) => `<section class="reviewer-tree-folder" data-folder="${subject.id}">
      <div class="folder-row"><button type="button" data-folder-toggle="${subject.id}" aria-expanded="false" aria-label="Expand ${escapeHtml(subject.name)}">▸</button><span aria-hidden="true">📁</span><input type="checkbox" data-folder-check="${subject.id}" ${reviewers.length ? "" : "disabled"}><span class="topic-name">${escapeHtml(subject.name)}</span></div>
      <div class="reviewer-tree-children" data-folder-children="${subject.id}" hidden>${reviewers.map((reviewer) => `<label class="reviewer-tree-row"><input type="checkbox" data-reviewer-check value="${reviewer.id}" data-subject="${subject.id}" ${preselected.has(reviewer.id) ? "checked" : ""}><span>${escapeHtml(reviewer.title)}</span></label>`).join("") || '<p class="muted">No reviewers in this subject.</p>'}</div>
    </section>`).join("");
    openWideModal("Build a Quiz", "REVIEWERS", `<p class="muted">Choose the reviewers to include in your quiz.</p><div class="inline-actions reviewer-tree-tools"><button type="button" class="small-link" id="reviewers-select-all">Select all</button><button type="button" class="small-link" id="reviewers-deselect-all">Deselect all</button></div>
      <div class="folder-tree" id="reviewer-tree">${html || emptyState("No subjects yet", "Create a subject and add reviewers first.")}</div>
      <div class="ai-form"><div class="two-col"><label>Questions<input type="number" id="qz-count" min="3" max="20" value="5"></label><label>Difficulty<select id="qz-difficulty"><option value="easy">Easy</option><option value="medium" selected>Medium</option><option value="hard">Hard</option></select></label></div><p class="form-error" id="qz-error"></p><div class="modal-actions"><button type="button" class="secondary" id="qz-cancel">Cancel</button><button type="button" class="primary" id="qz-go">✦ Generate quiz</button></div></div>`);
    const body = $("#modal-body");
    const updateFolder = (id) => {
      const children = $$(`[data-folder-children="${id}"] [data-reviewer-check]`, body);
      const folderCheck = $(`[data-folder-check="${id}"]`, body);
      const checked = children.filter((x) => x.checked).length;
      folderCheck.checked = children.length > 0 && checked === children.length;
      folderCheck.indeterminate = checked > 0 && checked < children.length;
    };
    tree.forEach(({ subject, reviewers }) => {
      const folder = subject.id;
      const disclosure = $(`[data-folder-toggle="${folder}"]`, body);
      const children = $(`[data-folder-children="${folder}"]`, body);
      disclosure.onclick = () => { const open = children.hidden; children.hidden = !open; disclosure.textContent = open ? "▾" : "▸"; disclosure.setAttribute("aria-expanded", String(open)); };
      $(`[data-folder-check="${folder}"]`, body).onchange = (event) => { $$(`[data-folder-children="${folder}"] [data-reviewer-check]`, body).forEach((x) => x.checked = event.target.checked); updateFolder(folder); };
      $$(`[data-folder-children="${folder}"] [data-reviewer-check]`, body).forEach((x) => x.onchange = () => updateFolder(folder));
      updateFolder(folder);
    });
    $("#reviewers-select-all").onclick = () => { $$('[data-reviewer-check]', body).forEach((x) => x.checked = true); tree.forEach(({ subject }) => updateFolder(subject.id)); };
    $("#reviewers-deselect-all").onclick = () => { $$('[data-reviewer-check]', body).forEach((x) => x.checked = false); tree.forEach(({ subject }) => updateFolder(subject.id)); };
    $("#qz-cancel").onclick = () => { closeModal(); const only = prefill.subjectIds?.length === 1 ? prefill.subjectIds[0] : null; if (only) openSubject(only, "quizzes").catch((e) => toast(e.message)); };
    $("#qz-go").onclick = async () => {
      const reviewerIds = $$('[data-reviewer-check]:checked', body).map((x) => x.value);
      const subjectIds = [...new Set($$('[data-reviewer-check]:checked', body).map((x) => x.dataset.subject))];
      if (!reviewerIds.length) return $("#qz-error").textContent = "Select at least one reviewer.";
      const button = $("#qz-go"); button.disabled = true; button.innerHTML = '<span class="btn-spinner" aria-hidden="true"></span>Writing questions…';
      try {
        const { quiz } = await api(`/ai/${cid()}/quizzes/generate`, { method: "POST", body: { subject_ids: subjectIds, reviewer_ids: reviewerIds, count: Number($("#qz-count").value), difficulty: $("#qz-difficulty").value } });
        trackEvent("ai_used", { tool: "quiz" });
        showQuizPreview(quiz, { subjectIds, reviewerIds, subjectName: subjectIds.length === 1 ? tree.find((x) => x.subject.id === subjectIds[0])?.subject.name : null });
      } catch (error) { $("#qz-error").textContent = error.message; button.disabled = false; button.textContent = "✦ Generate quiz"; }
    };
  } catch (error) { openWideModal("Build a Quiz", "REVIEWERS", `<p class="form-error">${escapeHtml(error.message)}</p><button type="button" class="secondary" id="qz-load-close">Close</button>`); $("#qz-load-close").onclick = closeModal; }
}

function showQuizPreview(quiz, meta) {
  openWideModal("Review before saving", "AI QUIZ", `
    <div class="ai-form">
      <label>Quiz title<input id="qz-title" maxlength="200" value="${escapeHtml(quiz.title)}"></label>
      <p class="hint">${quiz.questions.length} questions · ${escapeHtml(quiz.difficulty)}. Uncheck any you don't want to keep.</p>
      <div class="quiz-review">${quiz.questions.map((q, i) => `<label class="quiz-q"><input type="checkbox" checked data-keep="${i}" class="quiz-keep"><div><p class="quiz-q-text">${i + 1}. ${escapeHtml(q.question)}</p>
        <ul class="quiz-options">${q.options.map((o, oi) => `<li class="${oi === q.answer ? "correct" : ""}">${escapeHtml(o)}${oi === q.answer ? " ✓" : ""}</li>`).join("")}</ul>
        ${q.explanation ? `<p class="hint">${escapeHtml(q.explanation)}</p>` : ""}</div></label>`).join("")}</div>
      <p class="form-error" id="qz-error"></p>
      <div class="modal-actions"><button type="button" class="secondary" id="qz-back">← Back</button><button type="button" class="primary" id="qz-save">Save quiz</button></div>
    </div>`);
  $("#qz-back").onclick = () => openQuizBuilder({ subjectIds: meta.subjectIds, reviewerIds: meta.reviewerIds, subjectName: meta.subjectName });
  $("#qz-save").onclick = async () => {
    const keep = $$("[data-keep]", $("#modal-body")).filter((c) => c.checked).map((c) => Number(c.dataset.keep));
    const questions = keep.map((i) => quiz.questions[i]);
    if (!questions.length) return ($("#qz-error").textContent = "Keep at least one question.");
    const button = $("#qz-save"); button.disabled = true; button.textContent = "Saving…";
    try {
      const subjectId = meta.subjectIds?.length === 1 ? meta.subjectIds[0] : null;
      await api(`/ai/${cid()}/quizzes`, { method: "POST", body: { title: $("#qz-title").value.trim(), difficulty: quiz.difficulty, subject_id: subjectId, questions } });
      toast("Quiz saved.");
      closeModal();
      await renderPage();
    } catch (error) { $("#qz-error").textContent = error.message; button.disabled = false; button.textContent = "Save quiz"; }
  };
}

/* ---- take a saved quiz ---- */
async function openQuiz(quizId) {
  openWideModal("Loading quiz", "AI QUIZ", '<div class="modal-skeleton" aria-label="Loading quiz"><span class="skeleton-line"></span><span class="skeleton-line"></span><span class="skeleton-line"></span></div>');
  const { quiz, attempts } = await api(`/ai/${cid()}/quizzes/${quizId}`);
  const dueIndices = new Set((quiz.due_question_indices || []).map(Number));
  quiz.questions = (quiz.questions || []).map((question, sourceIndex) => ({ ...question, source_index: sourceIndex }))
    .sort((a, b) => Number(dueIndices.has(b.source_index)) - Number(dueIndices.has(a.source_index)));
  let history = `<p class="muted" style="margin-top:12px">You haven't taken this quiz yet.</p>`;
  let weak = "";
  if (attempts.length) {
    const chrono = [...attempts].reverse();
    const best = Math.max(...attempts.map((a) => (a.total ? Math.round((a.score / a.total) * 100) : 0)));
    const bars = chrono.map((a) => {
      const pct = a.total ? Math.round((a.score / a.total) * 100) : 0;
      return `<div class="attempt-bar" style="height:${Math.max(6, pct)}%"><span>${pct}</span><em>${escapeHtml(fmtShortDate(a.created_at))}</em></div>`;
    }).join("");
    history = `<div class="section-title" style="margin:14px 0 8px"><h3 class="sub">Your progress</h3></div>
      <div class="quiz-stats">
        <div class="meta-chip"><span class="stat-label">LAST</span><strong>${attempts[0].score}/${attempts[0].total}</strong></div>
        <div class="meta-chip"><span class="stat-label">BEST</span><strong>${best}%</strong></div>
        <div class="meta-chip"><span class="stat-label">ATTEMPTS</span><strong>${attempts.length}</strong></div>
      </div>
      <div class="attempt-bars">${bars}</div>`;
    const misses = quiz.questions.map((q, i) => {
      let wrong = 0, seen = 0;
      for (const a of attempts) {
        const ans = Array.isArray(a.answers) ? a.answers[q.source_index] : undefined;
        if (ans === null || ans === undefined) continue;
        seen += 1;
        if (ans !== q.answer) wrong += 1;
      }
      return { q, wrong, seen };
    }).filter((m) => m.wrong > 0).sort((a, b) => b.wrong - a.wrong).slice(0, 5);
    if (misses.length) weak = `<div class="section-title" style="margin:16px 0 8px"><h3 class="sub">Focus on these</h3></div>
      <div class="item-list">${misses.map((m) => `<div class="item-card"><div class="class-avatar">!</div><div class="item-main"><h3>${escapeHtml(m.q.question)}</h3><p>missed ${m.wrong} of ${m.seen} time${m.seen === 1 ? "" : "s"}</p></div></div>`).join("")}</div>`;
  }
  const dueHint = dueIndices.size ? `<p class="quiz-review-hint">${dueIndices.size} question${dueIndices.size === 1 ? " is" : "s are"} due for review. They’ll appear first.</p>` : "";
  openWideModal(quiz.title, "AI QUIZ", `
    <p class="muted">${quiz.questions.length} questions · ${escapeHtml(quiz.difficulty)}${quiz.subject_name ? ` · ${escapeHtml(quiz.subject_name)}` : ""} · by ${escapeHtml(quiz.full_name || quiz.username)}</p>
    ${dueHint}${history}${weak}
    <div class="modal-actions"><button type="button" class="secondary" id="qz-close">Close</button><button type="button" class="primary" id="qz-start">${attempts.length ? "Retake quiz" : "Start quiz"}</button></div>`);
  $("#qz-close").onclick = () => closeModal();
  $("#qz-start").onclick = () => runQuiz(quiz);
}

function runQuiz(quiz) {
  const answers = Array(quiz.questions.length).fill(null);
  let index = 0;
  const render = () => {
    const q = quiz.questions[index];
    const sourceIndex = q.source_index ?? index;
    const atLast = index === quiz.questions.length - 1;
    openWideModal(quiz.title, "AI QUIZ", `
      <form id="quiz-run" class="ai-form"><div class="quiz-run-paged">
        <p class="pill">Question ${index + 1} of ${quiz.questions.length}</p>
        <fieldset class="quiz-run-q"><legend>${escapeHtml(q.question)}</legend>
          ${q.options.map((o, oi) => `<label class="quiz-choice"><input type="radio" name="q${index}" value="${oi}" ${answers[index] === oi ? "checked" : ""}><span>${escapeHtml(o)}</span></label>`).join("")}
        </fieldset></div><p class="form-error" id="qz-error"></p>
        <div class="modal-actions"><button type="button" class="secondary" id="qz-quit">Quit</button>${index ? '<button type="button" class="secondary" id="qz-prev">Previous</button>' : ''}${atLast ? '<button type="submit" class="primary">Submit Quiz</button>' : '<button type="button" class="primary" id="qz-next">Next</button>'}</div></form>`);
    const form = $("#quiz-run");
    const move = (direction) => {
      const picked = $("input[name=q" + index + "]:checked", form);
      if (picked) answers[index] = Number(picked.value);
      if (index + direction < 0 || index + direction >= quiz.questions.length) return;
      index += direction; render();
    };
    $("#qz-quit").onclick = () => closeModal();
    if (index) $("#qz-prev").onclick = () => move(-1);
    if (!atLast) $("#qz-next").onclick = () => move(1);
    wireSwipe(form, () => move(1), () => move(-1));
    form.onsubmit = async (e) => {
      e.preventDefault();
      const picked = $("input[name=q" + index + "]:checked", form); if (picked) answers[index] = Number(picked.value);
      const ordered = Array(quiz.questions.length).fill(null);
      quiz.questions.forEach((question, i) => { ordered[question.source_index ?? i] = answers[i]; });
      try { const { attempt, review } = await api(`/ai/${cid()}/quizzes/${quiz.id}/attempts`, { method: "POST", body: { answers: ordered } }); showQuizResult(quiz, attempt, review); }
      catch (error) { $("#qz-error").textContent = error.message; }
    };
  };
  render();
}

function showQuizResult(quiz, attempt, review) {
  const pct = attempt.total ? Math.round((attempt.score / attempt.total) * 100) : 0;
  const verdict = pct === 100 ? "Perfect!" : pct >= 70 ? "Nice work." : "Keep reviewing.";
  openWideModal("Result", "AI QUIZ", `
    <div class="score-banner ${pct >= 70 ? "good" : ""}"><span class="score-num">${attempt.score}/${attempt.total}</span><span>${pct}% · ${verdict}</span></div>
    <div class="quiz-review">${quiz.questions.map((q, i) => {
      const sourceIndex = q.source_index ?? i;
      const r = review.find((x) => x.index === sourceIndex) || {};
      return `<div class="quiz-q"><div><p class="quiz-q-text">${i + 1}. ${escapeHtml(q.question)}</p>
        <ul class="quiz-options">${q.options.map((o, oi) => {
          const cls = oi === q.answer ? "correct" : (oi === r.chosen && !r.is_correct ? "wrong" : "");
          return `<li class="${cls}">${escapeHtml(o)}${oi === q.answer ? " ✓" : ""}${oi === r.chosen && !r.is_correct ? " ✗ your answer" : ""}</li>`;
        }).join("")}</ul>
        ${r.explanation ? `<p class="hint">${escapeHtml(r.explanation)}</p>` : ""}</div></div>`;
    }).join("")}</div>
    <div class="modal-actions"><button type="button" class="secondary" id="qz-again">Try again</button><button type="button" class="primary" id="qz-done">Done</button></div>`);
  $("#qz-again").onclick = () => runQuiz(quiz);
  $("#qz-done").onclick = async () => { closeModal(); await renderPage(); };
}

/* ---------- study plan (AI) ---------- */
function studyPlanHtml(plan) {
  if (!plan || !plan.sessions || !plan.sessions.length) {
    return `<p class="hint">Classlie plans a realistic study week around your class times and due dates. It avoids your class hours and prioritises what's due soonest.</p>`;
  }
  const order = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const byDay = order.map((day) => [day, plan.sessions.filter((s) => s.day === day)]).filter(([, list]) => list.length);
  const dayBlocks = byDay.map(([day, list]) => `<div class="plan-day"><h4>${escapeHtml(day)}</h4>${list.map((s) => `<div class="plan-session" style="--accent:${escapeHtml(subjectAccent(s.subject))}">
      <div class="plan-time">${escapeHtml(fmtTime(s.start_time))}<br><span>${escapeHtml(fmtTime(s.end_time))}</span></div>
      <div class="plan-info"><h5>${escapeHtml(s.subject || "Study")}</h5><p>${escapeHtml(s.focus)}</p>${s.note ? `<span class="plan-note">💡 ${escapeHtml(s.note)}</span>` : ""}</div></div>`).join("")}</div>`).join("");
  return `${plan.summary ? `<p class="muted">${escapeHtml(plan.summary)}</p>` : ""}
    <div class="plan-grid">${dayBlocks}</div>
    <p class="fine-print">Generated ${escapeHtml(fmtDate(plan.generated_at))} — this is your own plan, only you can see it.</p>`;
}
function planActions(hasplan) {
  return `<div class="modal-actions">${hasplan ? `<button type="button" class="danger-button" id="plan-clear">Clear</button>` : ""}<button type="button" class="secondary" id="plan-close">Close</button><button type="button" class="primary" id="plan-gen">${hasplan ? "✦ Regenerate" : "✦ Generate plan"}</button></div>`;
}
async function openStudyPlan() {
  let plan = null;
  try { ({ plan } = await api(`/ai/${cid()}/study-plan`)); }
  catch (error) { toast(error.message); return; }
  openWideModal(plan ? (plan.title || "Your study week") : "Study plan", "AI STUDY PLANNER", `${studyPlanHtml(plan)}${planActions(!!plan)}`);
  $("#plan-close").onclick = closeModal;
  const clear = $("#plan-clear");
  if (clear) clear.onclick = async () => {
    if (!confirm("Clear your study plan?")) return;
    try { await api(`/ai/${cid()}/study-plan`, { method: "DELETE" }); toast("Study plan cleared."); openStudyPlan(); } catch (e) { toast(e.message); }
  };
  $("#plan-gen").onclick = async () => {
    const button = $("#plan-gen");
    button.disabled = true;
    button.textContent = "Planning…";
    try {
      const result = await api(`/ai/${cid()}/study-plan`, { method: "POST" });
      trackEvent("ai_used", { tool: "study_plan" });
      if (!result.plan.sessions.length) { toast("Nothing to plan yet — add some tasks or a schedule first."); openStudyPlan(); return; }
      openStudyPlan();
      toast("Study plan ready.");
    } catch (error) {
      toast(error.message);
      button.disabled = false;
      button.textContent = plan ? "✦ Regenerate" : "✦ Generate plan";
    }
  };
}

/* ---------- ClasslieAI assistant ---------- */
function aiChatKey() { return `classlie_aichat_${cid()}`; }
function loadAiChat() {
  try {
    const rows = JSON.parse(store.get(aiChatKey())) || [];
    return Array.isArray(rows)
      ? rows.filter((m) => m && !m.pending && m.content !== "…").map(({ pending, typing, ...m }) => m)
      : [];
  } catch { return []; }
}
function saveAiChat() { store.set(aiChatKey(), JSON.stringify(state.aiChat.slice(-20))); }
function aiMessagesHtml() {
  if (!state.aiChat.length) {
    return `<div class="ai-empty"><div class="brand-mark small">✦</div><p>Hi! I'm <strong>ClasslieAI</strong>. Ask me about your tasks, schedule or reviewers.</p></div>`;
  }
  return state.aiChat.map((m) => {
    if (m.pending) return `<div class="ai-msg assistant pending"><div class="ai-bubble"><div class="ai-typing" aria-label="ClasslieAI is typing"><span></span><span></span><span></span></div></div></div>`;
    const body = m.role === "assistant" ? (m.typing ? "" : renderAiText(m.content)) : escapeHtml(m.content);
    return `<div class="ai-msg ${m.role}"><div class="ai-bubble">${body}</div></div>`;
  }).join("");
}
function paintAiChat() {
  const box = $("#ai-chat");
  if (!box) return;
  box.innerHTML = aiMessagesHtml();
  box.scrollTop = box.scrollHeight;
}
function typeOut(node, text) {
  return new Promise((resolve) => {
    const still = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (still || text.length > 5000) { node.textContent = text; resolve(); return; }
    let i = 0;
    const step = text.length > 800 ? 10 : text.length > 300 ? 6 : 3;
    node.textContent = "";
    const tick = () => {
      if (state.page !== "ai" || !node.isConnected) { node.textContent = text; resolve(); return; }
      i = Math.min(text.length, i + step);
      node.textContent = text.slice(0, i);
      const box = $("#ai-chat");
      if (box) box.scrollTop = box.scrollHeight;
      if (i >= text.length) resolve(); else setTimeout(tick, 16);
    };
    tick();
  });
}
async function aiSubmit(question) {
  question = String(question || "").trim();
  if (!question || state.aiBusy) return;
  const history = state.aiChat.filter((m) => !m.pending).slice(-6).map((m) => ({ role: m.role, content: m.content }));
  state.aiChat.push({ role: "user", content: question });
  state.aiChat.push({ role: "assistant", content: "…", pending: true });
  state.aiBusy = true;
  saveAiChat();
  paintAiChat();
  const input = $("#ai-input");
  const send = $("#ai-send");
  if (input) input.value = "";
  if (send) { send.disabled = true; send.innerHTML = '<span class="btn-spinner"></span>'; }
  try {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    const { answer } = await api(`/ai/${cid()}/assistant`, { method: "POST", body: { question, history, timezone } });
    const last = state.aiChat[state.aiChat.length - 1];
    last.content = answer;
    last.pending = false;
    last.typing = true;
    trackEvent("ai_used", { tool: "assistant" });
    paintAiChat();
    const bubbles = $$("#ai-chat .ai-msg.assistant .ai-bubble");
    const node = bubbles[bubbles.length - 1];
    await typeOut(node || document.createElement("div"), aiPlainText(answer));
    last.typing = false;
  } catch (error) {
    const last = state.aiChat[state.aiChat.length - 1];
    last.content = `Sorry — ${error.message}`;
    last.pending = false;
    last.typing = false;
    paintAiChat();
  } finally {
    state.aiBusy = false;
    saveAiChat();
    if (send) { send.disabled = false; send.textContent = "Send"; }
    if (input) input.focus();
  }
}
// Called after the page HTML is in the DOM.
function wireAI() {
  const form = $("#ai-form");
  if (!form) return;
  state.aiChat = loadAiChat();
  paintAiChat();
  form.onsubmit = (e) => { e.preventDefault(); aiSubmit($("#ai-input").value); };
  const input = $("#ai-input");
  if (input && !state.aiChat.length) input.focus();
}
// ClasslieAI lives on its own page; remember where the user came from so Back works.
function openClasslieAI() {
  if (!state.activeClass) { toast("Open a class first."); return; }
  if (state.page !== "ai") state.prevPage = state.page;
  state.page = "ai";
  renderPage();
}
async function renderAI() {
  state.aiChat = loadAiChat();
  return `<div class="ai-wrap">
  <div class="ai-head"><button class="icon-button" data-action="ai-back" aria-label="Back" title="Back">←</button><h2>ClasslieAI</h2></div>
  <div class="ai-chat" id="ai-chat"></div>
  <form id="ai-form" class="ai-input">
    <input id="ai-input" type="text" placeholder="Ask ClasslieAI…" autocomplete="off" maxlength="2000" aria-label="Your question">
    <button class="primary" type="submit" id="ai-send">Send</button>
  </form>
  </div>`;
}

/* ---------- members ---------- */
async function showMembers() {
  const { members } = await api(`/classes/${cid()}/members`);
  const me = state.user.id;
  const rows = members.map((m) => {
    const others = me !== m.id && m.role !== "owner";
    const ownerActions = isOwner() && me === m.id && members.some((member) => member.id !== me) ? `<button class="small-link owner-transfer" data-open-transfer>Transfer ownership</button>` : "";
    return `<tr><td>${avatarHtml({ fullName: m.full_name || m.username, username: m.username, avatar_url: m.avatar_url }, "avatar-sm")}${escapeHtml(m.full_name)}${me === m.id ? " (you)" : ""}<br><small>@${escapeHtml(m.username)}</small></td><td><span class="pill">${escapeHtml(m.role)}</span></td>
      <td><span class="member-active ${m.active ? "is-active" : ""}">${m.active ? "● Active" : "Status hidden"}</span><div class="member-actions">${ownerActions}${others && isOwner() ? `<button class="small-link" data-member-role="${m.id}" data-role="${m.role === "admin" ? "student" : "admin"}">${m.role === "admin" ? "Demote" : "Make admin"}</button>` : ""}${others && isAdmin() && !(state.activeClass.role === "admin" && m.role === "admin") ? `<button class="small-link link-danger" data-member-remove="${m.id}">Remove</button>` : ""}</div></td></tr>`;
  }).join("");
  openModal("Class members", "CLASS SETTINGS", `${state.user.activeStatus === false ? '<p class="callout">Active Status is turned off. You cannot see other members’ active status indicators.</p>' : ""}<div class="table-wrap"><table class="members-table"><thead><tr><th>Member</th><th>Role</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div>`);
  $$("[data-member-role]").forEach((b) => b.onclick = async () => {
    try { await api(`/classes/${cid()}/members/${b.dataset.memberRole}/role`, { method: "PATCH", body: { role: b.dataset.role } }); toast("Role updated."); await showMembers(); } catch (e) { toast(e.message); }
  });
  $$("[data-member-remove]").forEach((b) => b.onclick = async () => {
    if (!confirm("Remove this member from the class?")) return;
    try { await api(`/classes/${cid()}/members/${b.dataset.memberRemove}`, { method: "DELETE" }); toast("Member removed."); await showMembers(); } catch (e) { toast(e.message); }
  });
  $$('[data-open-transfer]').forEach((button) => button.onclick = () => openTransferOwnership(members.filter((member) => member.id !== me)));
}

function openTransferOwnership(members) {
  openModal("Transfer ownership", "CLASS SETTINGS", `<p class="muted">Choose the new owner. You’ll become an admin after the transfer.</p>
    <label>New owner<select id="transfer-target">${members.map((m) => `<option value="${m.id}">${escapeHtml(m.full_name || m.username)} · ${escapeHtml(m.role)}</option>`).join("")}</select></label>
    <label class="check-row"><input type="checkbox" id="transfer-confirm"> I confirm this ownership transfer.</label>
    <p class="form-error" id="transfer-error"></p><div class="modal-actions"><button class="secondary" id="transfer-cancel" type="button">Cancel</button><button class="primary" id="transfer-btn" type="button" disabled>Transfer ownership</button></div>`);
  $("#transfer-cancel").onclick = () => showMembers().catch((e) => toast(e.message));
  $("#transfer-confirm").onchange = (event) => { $("#transfer-btn").disabled = !event.target.checked; };
  $("#transfer-btn").onclick = async () => {
    try { await api(`/classes/${cid()}/owner`, { method: "PATCH", body: { userId: $("#transfer-target").value } }); closeModal(); toast("Ownership transferred."); await loadClasses(); await renderPage(); }
    catch (e) { $("#transfer-error").textContent = e.message; }
  };
}

/* ---------- class menu ---------- */
function openClassMenu() {
  const menu = $("#class-menu");
  if (menu) menu.classList.remove("hidden");
  state.classMenuOpen = true;
  $("#class-menu-btn").setAttribute("aria-expanded", "true");
}
function closeClassMenu() {
  const menu = $("#class-menu");
  if (menu) menu.classList.add("hidden");
  state.classMenuOpen = false;
  const btn = $("#class-menu-btn");
  if (btn) btn.setAttribute("aria-expanded", "false");
}

/* ---------- activity log ---------- */
async function openActivity() {
  const { activity } = await api(`/classes/${cid()}/activity`);
  const rows = activity.length ? activity.map((a) => `
    <div class="activity-item"><span class="activity-dot"></span><div><p>${escapeHtml(a.full_name || "Someone")} ${escapeHtml(a.summary)}</p><small>${escapeHtml(fmtDate(a.created_at))}</small></div></div>`).join("")
    : `<div class="empty">No activity yet. Changes will show up here.</div>`;
  openModal("Recent activity", "CLASS LOG", `<div class="activity-wrap"><div class="activity-list">${rows}</div><button type="button" class="activity-top-btn" id="activity-top-btn" aria-label="Back to top">↑ Top</button></div>`);
  setTimeout(() => {
    const body = $("#modal-body");
    const btn = $("#activity-top-btn");
    const list = body ? body.querySelector(".activity-list") : null;
    if (!body || !btn || !list) return;
    const update = () => {
      const atTop = body.scrollTop <= 10;
      btn.classList.toggle("show", !atTop && body.scrollHeight > body.clientHeight + 40);
    };
    btn.onclick = () => { body.scrollTo({ top: 0, behavior: "smooth" }); };
    body.addEventListener("scroll", update, { passive: true });
    update();
  }, 0);
}

/* ---------- actions ---------- */
async function handleAction(action, el) {
  const { id, resource } = el.dataset;
  if (action === "activity") return openActivity();
  if (action === "cal-prev" || action === "cal-next" || action === "cal-today") return navigateCalendar(action);
  if (action === "create-class") return openCreateClass();
  if (action === "join-class") return openJoinClass();
  if (action === "open-class") { await selectClass(id); return renderPage(); }
  if (action === "edit-class") return openEditClass();
  if (action === "members") return showMembers();
  if (action === "open-subject") return openSubject(id);
  if (action === "add-item") return openItemForm(resource);
  if (action === "scan-schedule") return openScheduleScan();
  if (action === "toggle-schedule-edit") { state.scheduleEdit = !state.scheduleEdit; return renderPage(); }
  if (action === "toggle-task-edit") { state.taskEditMode = !state.taskEditMode; return renderPage(); }
  if (action === "ai-reviewer") return openReviewerGenerator();
  if (action === "ai-quiz") return openQuizBuilder();
  if (action === "study-plan") return openStudyPlan();
  if (action === "ai-chat") return openClasslieAI();
  if (action === "ai-back") { state.page = state.prevPage || "overview"; return renderPage(); }
  if (action === "add-upload") return openUploadForm();
  if (action === "add-attendance") return openAttendanceForm();
  if (action === "edit-item") {
    openModal("Loading item", "CLASSLIE", '<div class="modal-skeleton" aria-label="Loading item"><span class="skeleton-line"></span><span class="skeleton-line"></span></div>');
    const rows = await fetchResource(resource);
    const item = rows.find((x) => x.id === id);
    if (!item) throw new Error("That item no longer exists.");
    return openItemForm(resource, item);
  }
  if (action === "delete-item") {
    if (!confirm("Delete this item? This can’t be undone.")) return;
    await api(`/class-data/${cid()}/${resource}/${id}`, { method: "DELETE" });
    toast("Item deleted.");
    return renderPage();
  }
  if (action === "copy-code") {
    try { await navigator.clipboard.writeText(state.activeClass.code); toast("Class code copied."); }
    catch { toast(`Couldn’t copy automatically. The code is ${state.activeClass.code}.`); }
    return;
  }
  if (action === "leave-class") {
    if (!confirm(`Leave “${state.activeClass.name}”? You can rejoin later with the class code.`)) return;
    await api(`/classes/${cid()}/leave`, { method: "DELETE" });
    await loadClasses();
    toast("You left the class.");
    return renderPage();
  }
}
let selectionHoldTimer = null;
let selectionHoldTarget = null;
let selectionHoldStart = null;
let suppressSelectionClick = null;
function selectedTotal() { return state.selected.subjects.length + state.selected.tasks.length; }
function syncSelectionBar() {
  const bar = $("#selection-bar"); if (!bar) return;
  const count = selectedTotal();
  bar.classList.toggle("visible", count > 0);
  bar.setAttribute("aria-hidden", String(count === 0));
  $("#selection-count").textContent = `${count} selected`;
  $("#selection-delete").onclick = async () => {
    if (!count || !confirm(`Delete ${count} selected item${count === 1 ? "" : "s"}? This can’t be undone.`)) return;
    try {
      for (const resource of ["subjects", "tasks"]) {
        const ids = state.selected[resource];
        if (ids.length) await api(`/class-data/${cid()}/${resource}/bulk-delete`, { method: "POST", body: { ids } });
      }
      state.selected = { subjects: [], tasks: [] }; state.selectionActive = false;
      toast(`Deleted ${count} item${count === 1 ? "" : "s"}.`); await renderPage();
    } catch (error) { toast(error.message); }
  };
  $("#selection-cancel").onclick = () => {
    state.selected = { subjects: [], tasks: [] }; state.selectionActive = false;
    $$(".is-selected").forEach((item) => item.classList.remove("is-selected"));
    bar.classList.remove("visible"); bar.setAttribute("aria-hidden", "true");
  };
}
function cancelSelectionHold() { clearTimeout(selectionHoldTimer); selectionHoldTimer = null; selectionHoldTarget = null; selectionHoldStart = null; }
function toggleSelectedItem(element) {
  const kind = element.dataset.selectable, id = element.dataset.selectId;
  if (!state.selected[kind]) state.selected[kind] = [];
  state.selected[kind] = state.selected[kind].includes(id) ? state.selected[kind].filter((x) => x !== id) : [...state.selected[kind], id];
  element.classList.toggle("is-selected", state.selected[kind].includes(id));
  if (!selectedTotal()) state.selectionActive = false;
  syncSelectionBar();
}
function wireLongPressSelection(root) {
  if (!root || root.dataset.selectionBound) return;
  root.dataset.selectionBound = "true";
  root.addEventListener("pointerdown", (event) => {
    const card = event.target.closest("[data-selectable]");
    if (!card || !isAdmin() || event.button > 0 || event.target.closest("input,select,textarea")) return;
    cancelSelectionHold(); selectionHoldTarget = card; selectionHoldStart = { x: event.clientX, y: event.clientY };
    selectionHoldTimer = setTimeout(() => {
      state.selectionActive = true;
      if (!state.selected[card.dataset.selectable].includes(card.dataset.selectId)) state.selected[card.dataset.selectable].push(card.dataset.selectId);
      card.classList.add("is-selected"); suppressSelectionClick = card.dataset.selectId;
      syncSelectionBar(); selectionHoldTimer = null;
    }, 450);
  });
  root.addEventListener("pointermove", (event) => {
    if (!selectionHoldStart) return;
    if (Math.hypot(event.clientX - selectionHoldStart.x, event.clientY - selectionHoldStart.y) > 10) cancelSelectionHold();
  }, { passive: true });
  root.addEventListener("pointerup", cancelSelectionHold);
  root.addEventListener("pointercancel", cancelSelectionHold);
  root.addEventListener("contextmenu", (event) => { if (event.target.closest("[data-selectable]") && (selectionHoldTimer || state.selectionActive)) event.preventDefault(); });
  root.addEventListener("click", (event) => {
    const card = event.target.closest("[data-selectable]");
    if (!card || !isAdmin() || event.target.closest(".task-toggle,[data-action=edit-item],[data-action=delete-item]")) return;
    if (suppressSelectionClick === card.dataset.selectId) { suppressSelectionClick = null; event.preventDefault(); event.stopImmediatePropagation(); return; }
    if (!state.selectionActive) return;
    event.preventDefault(); event.stopImmediatePropagation(); toggleSelectedItem(card);
  }, true);
}
function wireSwipe(element, onLeft, onRight) {
  if (!element) return;
  element.classList.add("swipe-surface");
  let start = null;
  element.addEventListener("pointerdown", (event) => { start = { x: event.clientX, y: event.clientY }; }, { passive: true });
  element.addEventListener("pointerup", (event) => {
    if (!start) return;
    const dx = event.clientX - start.x, dy = event.clientY - start.y; start = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.3) (dx < 0 ? onLeft : onRight)();
  }, { passive: true });
  element.addEventListener("pointercancel", () => { start = null; });
}
function shiftTaskFilter(direction) {
  const filters = ["all", "todo", "done", "overdue"];
  state.tasksFilter = filters[(filters.indexOf(state.tasksFilter) + direction + filters.length) % filters.length];
  savePrefs({ tasksFilter: state.tasksFilter }); renderPage();
}

function bindPageEvents() {
  const root = $("#page-content");
  wireLongPressSelection(root);
  $$("[data-action]", root).forEach((el) => el.addEventListener("click", async (event) => {
    if (el.dataset.action.startsWith("cal-")) event.preventDefault();
    try { await withButtonLoading(el, () => handleAction(el.dataset.action, el)); } catch (e) { toast(e.message); }
  }));
  $$("[data-page-link]", root).forEach((el) => el.addEventListener("click", () => { state.page = el.dataset.pageLink; renderPage(); }));
  $$("[data-task-filter]", root).forEach((el) => el.addEventListener("click", () => { state.tasksFilter = el.dataset.taskFilter; savePrefs({ tasksFilter: state.tasksFilter }); renderPage(); }));
  const taskSort = $("[data-task-sort]", root);
  if (taskSort) taskSort.addEventListener("change", () => { state.taskSort = taskSort.value; savePrefs({ taskSort: state.taskSort }); renderPage(); });
  if (state.page === "tasks") wireSwipe($(".tasks-list-panel", root), () => shiftTaskFilter(1), () => shiftTaskFilter(-1));
  $$("[data-cal-day]", root).forEach((el) => el.addEventListener("click", () => openCalDay(el.dataset.calDay).catch((e) => toast(e.message))));
  $$("[data-att-take]", root).forEach((el) => el.addEventListener("click", () => withButtonLoading(el, () => openTakeAttendance(el.dataset.attTake)).catch((e) => toast(e.message))));
  $$("[data-att-edit]", root).forEach((el) => el.addEventListener("click", async () => {
    try {
      const { sessions } = await api(`/attendance/${cid()}/sessions`);
      const session = sessions.find((s) => s.id === el.dataset.attEdit);
      if (!session) throw new Error("That session no longer exists.");
      await openAttendanceForm(session);
    } catch (e) { toast(e.message); }
  }));
  $$("[data-upload-delete]", root).forEach((el) => el.addEventListener("click", async () => {
    if (!confirm("Delete this upload?")) return;
    try { await api(`/uploads/${cid()}/${el.dataset.uploadDelete}`, { method: "DELETE" }); toast("Upload deleted."); await renderPage(); } catch (e) { toast(e.message); }
  }));
  $$("[data-upload-file]", root).forEach((el) => el.addEventListener("click", () => downloadUpload(el.dataset.uploadFile, el.dataset.filename).catch((e) => toast(e.message))));
  $$("[data-quiz-open]", root).forEach((el) => el.addEventListener("click", () => openQuiz(el.dataset.quizOpen).catch((e) => toast(e.message))));
  $$("[data-quiz-delete]", root).forEach((el) => el.addEventListener("click", async () => {
    if (!confirm("Delete this quiz and all of its attempts?")) return;
    try { await api(`/ai/${cid()}/quizzes/${el.dataset.quizDelete}`, { method: "DELETE" }); toast("Quiz deleted."); await renderPage(); } catch (e) { toast(e.message); }
  }));
  wireTaskToggles(root);
  wireExpandable(root);
  wireAI();
}
// Dashboard cards start collapsed; click (or Enter/Space) expands one at a time.
function wireExpandable(root) {
  const closeOthers = (card) => $$(".item-card.expandable.open", root).forEach((other) => {
    if (other !== card) { other.classList.remove("open"); other.setAttribute("aria-expanded", "false"); }
  });
  $$(".item-card.expandable", root).forEach((card) => {
    const toggle = () => {
      const open = card.classList.toggle("open");
      card.setAttribute("aria-expanded", String(open));
      if (open) closeOthers(card);
    };
    card.addEventListener("click", (e) => {
      if (e.target.closest("input,button,a,select,textarea,label")) return;
      toggle();
    });
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
    });
  });
}
// Shared so task checkboxes also work inside the search dialog, not just on the Tasks page.
// Optimistic: the checkbox flips instantly, then syncs; we avoid a full re-render on success.
function wireTaskToggles(root, after) {
  $$(".task-toggle", root).forEach((el) => el.addEventListener("change", async () => {
    const want = el.checked;
    const card = el.closest(".item-card");
    const title = card ? card.querySelector(".task-title") : null;
    if (title) title.classList.toggle("done", want);
    el.disabled = true;
    try {
      await api(`/class-data/${cid()}/tasks/${el.dataset.id}/completion`, { method: "PUT", body: { completed: want } });
      const cached = state.cache.tasks;
      if (Array.isArray(cached)) { const t = cached.find((x) => x.id === el.dataset.id); if (t) t.completed = want; }
      if (after) await after(); else refreshNavBadges();
    } catch (e) {
      if (!navigator.onLine) {
        queueToggle(cid(), el.dataset.id, want);
        const cached = state.cache.tasks;
        if (Array.isArray(cached)) { const t = cached.find((x) => x.id === el.dataset.id); if (t) t.completed = want; }
        toast("Saved offline — it'll sync when you reconnect.");
      } else {
        el.checked = !want;
        if (title) title.classList.toggle("done", !want);
        toast(e.message);
      }
    } finally {
      el.disabled = false;
    }
  }));
}

/* ---------- keyboard shortcuts ---------- */
function isTyping(target) {
  return target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
}
function showShortcuts() {
  const mod = /mac/i.test(navigator.platform) ? "⌘" : "Ctrl";
  const rows = [[mod + " K", "Command palette"], ["n", "Add new"], ["o", "Home"], ["t", "Tasks & calendar"], ["?", "This help"], ["Esc", "Close a dialog"]];
  openModal("Keyboard shortcuts", "TIPS", `<div class="item-list">${rows.map(([key, label]) => `<div class="item-card"><div class="item-main"><h3>${escapeHtml(label)}</h3></div><span class="pill">${escapeHtml(key)}</span></div>`).join("")}</div>`);
}

/* ---------- command palette (Cmd/Ctrl-K) ---------- */
let paletteEl = null;
let paletteSearchToken = 0;
function paletteCommands() {
  const cmds = [];
  const go = (page, label, icon) => ({ label, hint: "Go to", icon, run: () => { state.page = page; return renderPage(); } });
  cmds.push(go("overview", "Home", "⌂"), go("schedule", "Schedule", "◷"), go("tasks", "Tasks & calendar", "☑"), go("notes", "Subjects", "▤"), go("attendance", "Attendance", "◉"));
  if (state.activeClass) {
    cmds.push({ label: "Ask ClasslieAI", hint: "Open", icon: "✦", run: () => openClasslieAI() });
    cmds.push({ label: "Study plan", hint: "Open", icon: "◈", run: () => openStudyPlan() });
  }
  if (state.activeClass && isAdmin()) {
    cmds.push({ label: "Add task", hint: "Create", icon: "＋", run: () => openItemForm("tasks") });
    cmds.push({ label: "Add schedule entry", hint: "Create", icon: "＋", run: () => openItemForm("schedules") });
    cmds.push({ label: "Add subject", hint: "Create", icon: "＋", run: () => openItemForm("subjects") });
  }
  if (state.activeClass && !isAdmin()) {
    cmds.push({ label: "Add a private task", hint: "Create", icon: "＋", run: () => openItemForm("tasks", null, { is_private: true }) });
  }
  if (state.activeClass) {
    cmds.push({ label: "Copy class code", hint: "Class", icon: "⧉", run: () => handleAction("copy-code", { dataset: {} }) });
    cmds.push({ label: "Open members", hint: "Class", icon: "☺", run: () => showMembers() });
    cmds.push({ label: "Recent activity", hint: "Class", icon: "≡", run: () => openActivity() });
  }
  state.classes.forEach((c) => cmds.push({ label: `Switch to ${c.name}`, hint: "Class", icon: (c.name || "?").slice(0, 1).toUpperCase(), run: async () => { await selectClass(c.id); return renderPage(); } }));
  cmds.push({ label: "Create a class", hint: "Class", icon: "＋", run: () => openCreateClass() });
  cmds.push({ label: "Join a class", hint: "Class", icon: "↗", run: () => openJoinClass() });
  cmds.push({ label: "Toggle dark mode", hint: "Appearance", icon: "◑", run: () => toggleTheme() });
  cmds.push({ label: "Keyboard shortcuts", hint: "Help", icon: "?", run: () => showShortcuts() });
  cmds.push({ label: "Profile", hint: "Account", icon: "☺", run: () => openProfile() });
  cmds.push({ label: "Sign out", hint: "Account", icon: "→", run: () => openLogoutConfirm() });
  return cmds;
}
async function paletteSearch(q, token, done) {
  try {
    const { results } = await api(`/class-data/${cid()}/search?q=${encodeURIComponent(q)}`);
    if (token !== paletteSearchToken) return;
    const out = [];
    const push = (rows, page, label) => (rows || []).slice(0, 3).forEach((r) => out.push({ label: r.title || r.name || String(r), sub: label, hint: "Match", icon: "⌕", run: () => { state.page = page; return renderPage(); } }));
    push(results.tasks, "tasks", "Task");
    push(results.schedules, "schedule", "Schedule");
    push(results.notes, "notes", "Reviewer");
    push(results.subjects, "notes", "Subject");
    done(out);
  } catch { /* search is best-effort */ }
}
function openPalette() {
  if (paletteEl) return;
  trackEvent("palette_opened");
  const dialog = document.createElement("dialog");
  dialog.className = "palette";
  dialog.setAttribute("aria-label", "Command palette");
  dialog.innerHTML = `<div class="palette-search"><span aria-hidden="true">⌕</span><input id="palette-input" type="text" placeholder="Search or jump to…" autocomplete="off" aria-label="Command or search"></div>
    <div class="palette-list" id="palette-list" role="listbox"></div>`;
  document.body.appendChild(dialog);
  paletteEl = dialog;
  const input = dialog.querySelector("#palette-input");
  const list = dialog.querySelector("#palette-list");
  let results = [];
  let active = 0;
  let searchResults = [];
  const highlight = () => $$(".palette-item", list).forEach((el, i) => el.classList.toggle("active", i === active));
  const render = () => {
    list.innerHTML = results.length
      ? results.map((r, i) => `<button class="palette-item${i === active ? " active" : ""}" role="option" data-index="${i}"><span class="palette-icon">${escapeHtml(r.icon || "")}</span><span class="item-main"><strong>${escapeHtml(r.label)}</strong>${r.sub ? `<small>${escapeHtml(r.sub)}</small>` : ""}</span><span class="palette-hint">${escapeHtml(r.hint || "")}</span></button>`).join("")
      : `<div class="empty">No matches.</div>`;
    $$(".palette-item", list).forEach((el, i) => {
      el.onmouseenter = () => { active = i; highlight(); };
      el.onclick = () => run(i);
    });
  };
  const run = (i) => {
    const cmd = results[i];
    closePalette();
    if (cmd) Promise.resolve().then(cmd.run).catch((e) => toast(e.message));
  };
  const update = (keepSearch = false) => {
    const q = input.value.trim().toLowerCase();
    if (!keepSearch) searchResults = [];
    const base = paletteCommands();
    const filtered = (q ? base.filter((c) => c.label.toLowerCase().includes(q)) : base).slice(0, 8);
    results = filtered.concat(searchResults);
    active = 0;
    render();
    if (!keepSearch && q.length >= 2 && state.activeClass) {
      const token = ++paletteSearchToken;
      paletteSearch(q, token, (out) => { searchResults = out; update(true); });
    }
  };
  input.addEventListener("input", () => update());
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); active = Math.min(active + 1, results.length - 1); highlight(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = Math.max(active - 1, 0); highlight(); }
    else if (e.key === "Enter") { e.preventDefault(); run(active); }
  });
  dialog.addEventListener("close", () => { paletteEl = null; dialog.remove(); });
  dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.close(); });
  update();
  dialog.showModal();
  input.focus();
}
function closePalette() { if (paletteEl) paletteEl.close(); }

/* ---------- auth (restored) ---------- */
function showAuth() { $("#auth-view").classList.remove("hidden"); $("#app-view").classList.add("hidden"); }
function showApp() { $("#auth-view").classList.add("hidden"); $("#app-view").classList.remove("hidden"); }
function showAuthForm(id) {
  ["auth-form","forgot-form","reset-form"].forEach((f) => { const el = $("#"+f); if (el) el.classList.add("hidden"); });
  const el = $("#"+id); if (el) el.classList.remove("hidden");
  const wrap = $("#auth-inner");
  if (wrap) wrap.dataset.form = id;
}
function setAuthMode(mode) {
  state.authMode = mode;
  $$("[data-auth-mode]").forEach((b) => b.classList.toggle("active", b.dataset.authMode === mode));
  const isRegister = mode === "register";
  // Hidden required inputs still participate in native form validation. Disable
  // the fields for the inactive mode so they cannot prevent form submission.
  ["fullName", "username", "email"].forEach((name) => {
    const input = $(`#auth-form [name="${name}"]`);
    if (input) input.disabled = !isRegister;
  });
  const loginInput = $('#auth-form [name="login"]');
  if (loginInput) loginInput.disabled = isRegister;
  $("#full-name-wrap").classList.toggle("hidden", !isRegister);
  $("#username-wrap").classList.toggle("hidden", !isRegister);
  $("#email-wrap").classList.toggle("hidden", !isRegister);
  $("#login-wrap").classList.toggle("hidden", isRegister);
  $("#remember-wrap").classList.toggle("hidden", isRegister);
  const btn = $("#auth-submit");
  if (btn) btn.innerHTML = isRegister ? "Create account <span>→</span>" : "Sign in <span>→</span>";
  showAuthForm("auth-form");
  const form = $("#auth-form");
  if (form) {
    form.classList.remove("auth-switching");
    void form.offsetWidth;
    form.classList.add("auth-switching");
    clearTimeout(form.authSwitchTimer);
    form.authSwitchTimer = setTimeout(() => form.classList.remove("auth-switching"), 320);
  }
}
function clearResetParam() {
  const url = new URL(window.location.href); url.searchParams.delete("reset"); history.replaceState({}, "", url);
}
async function handleAuth(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const btn = $("#auth-submit");
  btn.disabled = true;
  $("#auth-error").textContent = "";
  try {
    const d = Object.fromEntries(new FormData(form).entries());
    if (state.authMode === "register") {
      const r = await api("/auth/register", { method: "POST", body: { fullName: d.fullName, username: d.username, email: d.email, password: d.password } });
      state.token = r.token; state.user = r.user; setToken(r.token, !!d.remember); setCachedUser(r.user, !!d.remember);
    } else {
      const r = await api("/auth/login", { method: "POST", body: { login: d.login, password: d.password } });
      state.token = r.token; state.user = r.user; setToken(r.token, !!d.remember); setCachedUser(r.user, !!d.remember);
    }
    renderUserChip();
    showApp();
    await loadClasses();
    await renderPage();
  } catch (err) {
    $("#auth-error").textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}
function renderUserChip() { const el = $("#user-chip"); if (el && state.user) { el.innerHTML = `${avatarHtml(state.user, "avatar-top")}<span class="sr-only">${escapeHtml(state.user.fullName || state.user.username)}</span>`; el.title = state.user.fullName || state.user.username; } }
function pageSkeleton() {
  return `<div class="skeleton-stack page-skeleton" aria-hidden="true">
    <div class="page-head"><div class="skeleton-copy"><div class="skel" style="width:90px"></div><div class="skel head"></div></div></div>
    <div class="panel"><div class="skel head"></div><div class="skel row"></div><div class="skel row"></div></div>
    <div class="panel"><div class="skel head"></div><div class="skel row"></div></div>
  </div>`;
}
async function loadClasses() {
  const result = await api("/classes");
  state.classes = Array.isArray(result.classes) ? result.classes : [];
  const savedId = store.get(CLASS_KEY);
  const next = state.classes.find((c) => c.id === savedId) || state.classes[0] || null;
  await selectClass(next ? next.id : null, false);
}
async function selectClass(classId, fetchDetails = true) {
  if (!classId) {
    state.activeClass = null;
    store.remove(CLASS_KEY);
  } else {
    let row = state.classes.find((c) => c.id === classId);
    if (fetchDetails || !row) {
      const result = await api(`/classes/${classId}`);
      state.activeClass = result.class;
      const index = state.classes.findIndex((c) => c.id === classId);
      if (index < 0) state.classes.push(result.class);
      else state.classes[index] = result.class;
    } else state.activeClass = row;
    store.set(CLASS_KEY, classId);
  }
  state.cache = {};
  const name = $("#class-menu-name");
  if (name) name.textContent = state.activeClass?.name || "Choose a class";
  const switcher = $("#class-switcher");
  if (switcher) {
    switcher.innerHTML = `<option value="">Choose a class</option>${state.classes.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`).join("")}`;
    switcher.value = state.activeClass?.id || "";
  }
  const ai = $("#ai-open");
  if (ai) ai.classList.toggle("hidden", !state.activeClass);
  return state.activeClass;
}
async function renderPage() {
  const root = $("#page-content");
  if (!root) return;
  const token = ++renderToken;
  const pages = { overview: renderOverview, schedule: renderSchedule, tasks: renderTasks, notes: renderNotes, attendance: renderAttendance, ai: renderAI };
  $$(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.page === state.page));
  if (!state.activeClass) {
    root.removeAttribute("aria-busy");
    root.innerHTML = `${pageHead("Your classrooms")}<div class="panel">${emptyState("Choose or create a class", "Create a classroom or join one with a class code to get started.")}<div class="action-row"><button class="primary" data-action="create-class">＋ Create class</button><button class="secondary" data-action="join-class">Join with code</button></div></div>`;
  } else {
    root.setAttribute("aria-busy", "true");
    root.innerHTML = pageSkeleton();
    const render = pages[state.page] || renderOverview;
    try {
      const html = await render();
      if (token !== renderToken) return;
      root.innerHTML = `<div class="page-enter">${html}</div>`;
      root.removeAttribute("aria-busy");
      syncSelectionBar();
      if (state.page === "ai") paintAiChat();
    } catch (error) {
      if (token !== renderToken) return;
      root.innerHTML = `<div class="page-enter">${pageHead("Couldn’t load this page")}<div class="panel"><p class="form-error">${escapeHtml(error.message || "Please try again.")}</p><button class="secondary" data-action="retry-page">Try again</button></div></div>`;
      root.removeAttribute("aria-busy");
      const retry = $("[data-action=retry-page]", root);
      if (retry) retry.onclick = () => renderPage();
    }
  }
  bindPageEvents();
  savePrefs({ page: state.page });
}
function refreshNavBadges() { /* Nav badges are optional and not present in the current shell. */ }
function logout(show = true) {
  if (show) return openLogoutConfirm();
  state.token = null; state.user = null; state.classes = []; state.activeClass = null; state.cache = {};
  clearToken(); store.remove(CLASS_KEY); store.remove(OUTBOX_KEY);
  showAuth();
  const root = $("#page-content"); if (root) root.replaceChildren();
}
function openLogoutConfirm() {
  openModal("Sign out?", "ACCOUNT", `<p class="muted">You can sign back in whenever you need to.</p><div class="modal-actions"><button type="button" class="secondary" id="logout-cancel">Cancel</button><button type="button" class="danger-button" id="logout-confirm">Sign out</button></div>`);
  $("#logout-cancel").onclick = closeModal;
  $("#logout-confirm").onclick = () => { closeModal(); logout(false); };
}
function bootApp() {
  renderUserChip();
  const menu = $("#class-menu");
  if (menu) menu.addEventListener("click", (event) => event.stopPropagation());
}
async function api(path, { method = "GET", body, headers = {} } = {}) {
  const res = await fetch(`/api${path}`, { method, headers: { "Content-Type": "application/json", ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
async function apiUpload(path, formData) {
  const headers = {};
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  let response;
  try {
    response = await fetch(`/api${path}`, { method: "POST", headers, body: formData });
  } catch {
    throw new Error("Can't reach the server. Check your connection and try again.");
  }
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && state.token) { logout(false); throw new Error("Please sign in again."); }
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
async function apiForm(path, formData) {
  const headers = {};
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  let response;
  try {
    response = await fetch(`/api${path}`, { method: "POST", headers, body: formData });
  } catch {
    throw new Error("Can't reach the server. Check your connection and try again.");
  }
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && state.token) { logout(false); throw new Error("Please sign in again."); }
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
async function fetchResource(r) {
  const result = await api(`/class-data/${cid()}/${r}`);
  return Array.isArray(result[r]) ? result[r] : [];
}

/* ---------- wiring ---------- */
$$("[data-auth-mode]").forEach((b) => b.addEventListener("click", () => setAuthMode(b.dataset.authMode)));
$("#auth-form").addEventListener("submit", handleAuth);
$("#forgot-link").addEventListener("click", () => showAuthForm("forgot-form"));
$("#back-to-login").addEventListener("click", () => { clearResetParam(); state.resetToken = null; setAuthMode("login"); });
$("#forgot-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget; // event.currentTarget is null after an await, so grab it now
  const button = $("#forgot-submit");
  button.disabled = true;
  try {
    const email = new FormData(form).get("email");
    await api("/auth/forgot", { method: "POST", body: { email } });
    form.reset();
    toast("If that email is registered, a reset link is on its way.");
    setAuthMode("login");
  } catch (error) {
    $("#forgot-error").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
$("#reset-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $("#reset-submit");
  button.disabled = true;
  try {
    const d = Object.fromEntries(new FormData(form).entries());
    if (d.password !== d.confirm) throw new Error("The two passwords don’t match.");
    await api("/auth/reset", { method: "POST", body: { token: state.resetToken, password: d.password } });
    form.reset();
    state.resetToken = null;
    clearResetParam();
    toast("Password updated. Please sign in.");
    setAuthMode("login");
  } catch (error) {
    $("#reset-error").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
$("#user-chip").addEventListener("click", openProfile);
$("#theme-toggle").addEventListener("click", toggleTheme);
$("#ai-open").addEventListener("click", () => openClasslieAI());
$("#class-menu-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  if (state.classMenuOpen) closeClassMenu();
  else openClassMenu();
});
document.addEventListener("click", (e) => {
  if (state.classMenuOpen && !e.target.closest("#class-menu")) closeClassMenu();
});
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
    if ($("#app-view").classList.contains("hidden")) return;
    e.preventDefault();
    if (paletteEl) closePalette(); else openPalette();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if ($("#app-view").classList.contains("hidden")) return;
  if (e.key === "Escape") { return closeClassMenu(); }
  if (isTyping(e.target) || $("#modal").open) return;
  if (e.key === "?") { e.preventDefault(); return showShortcuts(); }
  if (e.key === "o") { state.page = "overview"; return void renderPage(); }
  if (e.key === "t") { state.page = "tasks"; return void renderPage(); }
  if (e.key === "c") { state.page = "tasks"; return void renderPage(); }
  if (e.key === "n") { e.preventDefault(); return void handleAction("create-item", { dataset: {} }).catch((err) => toast(err.message)); }
});
$("#brand-home").addEventListener("click", (e) => { e.preventDefault(); state.page = "overview"; renderPage(); });
$("#class-switcher").addEventListener("change", async (e) => {
  closeClassMenu();
  try { await selectClass(e.target.value || null); await renderPage(); } catch (error) { toast(error.message); }
});
$("#create-class-open").addEventListener("click", () => { closeClassMenu(); openCreateClass(); });
$("#join-class-open").addEventListener("click", () => { closeClassMenu(); openJoinClass(); });
$$(".nav-item").forEach((b) => b.addEventListener("click", () => { state.page = b.dataset.page; renderPage(); }));
$("#modal").addEventListener("click", (e) => { if (e.target === $("#modal")) closeModal(); });
$("#modal").addEventListener("close", () => document.body.classList.remove("modal-open"));

/* ---------- pull to refresh (touch devices) ---------- */
function initPullToRefresh() {
  if (!window.matchMedia || !window.matchMedia("(pointer:coarse)").matches) return;
  const indicator = document.createElement("div");
  indicator.className = "ptr";
  indicator.setAttribute("aria-hidden", "true");
  indicator.innerHTML = '<span class="ptr-spinner">◐</span><span class="ptr-text">Pull to refresh</span>';
  document.body.appendChild(indicator);
  const text = indicator.querySelector(".ptr-text");
  const THRESHOLD = 72;
  const atTop = () => (window.scrollY || document.documentElement.scrollTop || 0) <= 0;
  let startY = 0, pulling = false, dist = 0, busy = false;
  window.addEventListener("touchstart", (e) => {
    if (busy || e.touches.length !== 1 || !atTop() || state.page === "ai" || ($("#modal") && $("#modal").open)) { pulling = false; return; }
    startY = e.touches[0].clientY; pulling = true; dist = 0;
  }, { passive: true });
  window.addEventListener("touchmove", (e) => {
    if (!pulling) return;
    dist = e.touches[0].clientY - startY;
    if (dist <= 0) { indicator.classList.remove("show", "ready"); indicator.style.transform = ""; return; }
    e.preventDefault();
    const eased = Math.min(dist, 130) * 0.55;
    indicator.classList.add("show");
    indicator.classList.toggle("ready", dist > THRESHOLD);
    indicator.style.transform = `translate(-50%, ${eased - 60}px)`;
    text.textContent = dist > THRESHOLD ? "Release to refresh" : "Pull to refresh";
  }, { passive: false });
  const reset = () => { indicator.classList.remove("show", "ready", "loading"); indicator.style.transform = ""; };
  window.addEventListener("touchend", () => {
    if (!pulling) return;
    pulling = false;
    if (dist <= THRESHOLD) { reset(); return; }
    busy = true;
    indicator.classList.add("loading");
    text.textContent = "Refreshing…";
    indicator.style.transform = "translate(-50%, 30px)";
    state.cache = {};
    Promise.resolve()
      .then(() => renderPage())
      .catch(() => {})
      .then(() => { setTimeout(() => { busy = false; reset(); }, 400); });
  });
  window.addEventListener("touchcancel", () => { pulling = false; reset(); });
}

function initSwipeNavigation() {
  const root = $("#page-content");
  if (!root) return;
  const pages = ["overview", "schedule", "tasks", "notes", "attendance"];
  let start = null;
  let calendarClickTimer = null;
  let calendarClickSuppressor = null;
  const suppressCalendarClickAfterSwipe = () => {
    if (calendarClickSuppressor) document.removeEventListener("click", calendarClickSuppressor, true);
    const onClick = (event) => {
      if (!event.target.closest?.("[data-cal-day]")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      document.removeEventListener("click", onClick, true);
      calendarClickSuppressor = null;
      clearTimeout(calendarClickTimer);
    };
    calendarClickSuppressor = onClick;
    document.addEventListener("click", onClick, true);
    clearTimeout(calendarClickTimer);
    calendarClickTimer = setTimeout(() => {
      document.removeEventListener("click", onClick, true);
      if (calendarClickSuppressor === onClick) calendarClickSuppressor = null;
    }, 700);
  };
  root.addEventListener("touchstart", (event) => {
    if (calendarClickSuppressor) {
      document.removeEventListener("click", calendarClickSuppressor, true);
      calendarClickSuppressor = null;
      clearTimeout(calendarClickTimer);
    }
    if (event.touches.length !== 1 || !pages.includes(state.page) || $("#modal")?.open) { start = null; return; }
    const target = event.target;
    if (target.closest("button,a,input,select,textarea,[role=button],[data-page-link],.week-grid,.table-wrap")) { start = null; return; }
    const x = event.touches[0].clientX;
    if (x < 18 || x > window.innerWidth - 18) { start = null; return; }
    start = { x, y: event.touches[0].clientY, page: state.page, inCalendar: !!target.closest(".cal-grid") };
  }, { passive: true });
  root.addEventListener("touchend", (event) => {
    if (!start || event.changedTouches.length !== 1) { start = null; return; }
    const dx = event.changedTouches[0].clientX - start.x;
    const dy = event.changedTouches[0].clientY - start.y;
    const from = pages.indexOf(start.page);
    const inCalendar = start.inCalendar;
    start = null;
    if (Math.abs(dx) < 65 || Math.abs(dx) < Math.abs(dy) * 1.35) return;
    const next = Math.max(0, Math.min(pages.length - 1, from + (dx < 0 ? 1 : -1)));
    if (next === from) return;
    if (inCalendar) suppressCalendarClickAfterSwipe();
    state.page = pages[next];
    $$(".nav-item[data-page]").forEach((button) => {
      button.classList.toggle("active", button.dataset.page === state.page);
    });
    renderPage();
  }, { passive: true });
  root.addEventListener("touchcancel", () => { start = null; }, { passive: true });
}

/* ---------- offline support ---------- */
const OUTBOX_KEY = "classlie_outbox";
function clearApiCache() {
  if (navigator.serviceWorker && navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage("clear-api-cache");
}
function loadOutbox() { try { return JSON.parse(store.get(OUTBOX_KEY)) || []; } catch { return []; } }
function saveOutbox(queue) { store.set(OUTBOX_KEY, JSON.stringify(queue)); updateOutboxIndicator(); }
function queueToggle(classId, taskId, completed) {
  const queue = loadOutbox().filter((x) => !(x.classId === classId && x.taskId === taskId));
  queue.push({ classId, taskId, completed });
  saveOutbox(queue);
}
function updateOutboxIndicator() {
  const bar = $("#offline-bar");
  if (!bar) return;
  const pending = loadOutbox().length;
  if (!navigator.onLine) { bar.textContent = pending ? `You're offline — ${pending} change${pending > 1 ? "s" : ""} will sync when you reconnect.` : "You're offline. Showing your last saved data."; bar.classList.remove("hidden"); }
  else if (pending) { bar.textContent = `Syncing ${pending} pending change${pending > 1 ? "s" : ""}…`; bar.classList.remove("hidden"); }
  else bar.classList.add("hidden");
}
let flushing = false;
async function flushOutbox() {
  if (flushing || !navigator.onLine || !state.user || !state.activeClass) return;
  const queue = loadOutbox();
  if (!queue.length) { updateOutboxIndicator(); return; }
  flushing = true;
  const remaining = [];
  for (const item of queue) {
    try {
      await api(`/class-data/${item.classId}/tasks/${item.taskId}/completion`, { method: "PUT", body: { completed: item.completed } });
    } catch (e) {
      if (!navigator.onLine) { remaining.push(item); } // still offline — keep it queued
      // otherwise the task likely no longer exists; drop it
    }
  }
  flushing = false;
  saveOutbox(remaining);
  if (!remaining.length) toast("All changes synced.");
  renderPage();
}
function initOffline() {
  const bar = document.createElement("div");
  bar.id = "offline-bar";
  bar.className = "offline-bar hidden";
  bar.setAttribute("role", "status");
  document.body.appendChild(bar);
  window.addEventListener("online", () => { updateOutboxIndicator(); flushOutbox(); });
  window.addEventListener("offline", updateOutboxIndicator);
  updateOutboxIndicator();
  if (navigator.onLine) flushOutbox();
}

/* ---------- add to home screen ---------- */
function isStandalone() {
  return (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || window.navigator.standalone === true;
}
function initInstallPrompt() {
  if (!window.matchMedia || !window.matchMedia("(pointer:coarse)").matches || isStandalone()) return;
  const visits = (parseInt(store.get("classlie_visits"), 10) || 0) + 1;
  store.set("classlie_visits", String(visits));
  const dismissedAt = parseInt(store.get("classlie_a2hs_dismissed"), 10) || 0;
  const tooSoon = Date.now() - dismissedAt < 30 * 864e5;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  let deferred = null;
  const show = () => {
    if (isStandalone() || $("#a2hs")) return;
    const el = document.createElement("div");
    el.id = "a2hs";
    el.className = "a2hs";
    el.innerHTML = `<div class="brand-logo a2hs-logo"><img class="logo-light" src="/logo_light.png" alt=""><img class="logo-dark" src="/logo_dark.png" alt=""></div>
      <div class="a2hs-text"><strong>Install Classlie</strong><span>${isIOS ? "Tap the Share button, then “Add to Home Screen”." : "Add it to your home screen for a faster, app-like experience."}</span></div>
      ${isIOS ? "" : '<button class="primary" id="a2hs-install" type="button">Install</button>'}
      <button class="icon-button" id="a2hs-close" type="button" aria-label="Dismiss">×</button>`;
    document.body.appendChild(el);
    const dismiss = () => { store.set("classlie_a2hs_dismissed", String(Date.now())); el.remove(); };
    $("#a2hs-close").onclick = dismiss;
    const installBtn = $("#a2hs-install");
    if (installBtn) installBtn.onclick = async () => {
      if (!deferred) return dismiss();
      deferred.prompt();
      try { await deferred.userChoice; } catch { /* user dismissed the prompt */ }
      deferred = null;
      dismiss();
    };
  };
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferred = e; if (visits >= 2 && !tooSoon) show(); });
  window.addEventListener("appinstalled", () => { deferred = null; $("#a2hs")?.remove(); store.set("classlie_installed", "1"); });
  if (isIOS && visits >= 2 && !tooSoon) setTimeout(show, 4000);
}

initTheme();
initPullToRefresh();
initSwipeNavigation();
initInstallPrompt();
initOffline();
if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    try {
      const reg = await navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" });
      reg.update().catch(() => {});
    } catch { /* offline or unsupported — the app still works without it */ }
  });
  // When a fresh service worker takes over, reload once so the newest assets are used.
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
}
// Keep the dashboard's "Ends in / Starts in" timer ticking without a full re-render.
setInterval(() => {
  const el = $("#next-class-countdown");
  if (!el) return;
  const target = new Date(el.dataset.target).getTime();
  const remaining = target - Date.now();
  const mode = el.dataset.mode === "end" ? "Ends in " : "Starts in ";
  el.textContent = remaining > 0 ? `${mode}${fmtCountdown(remaining)}` : (mode === "Ends in " ? "Ending now" : "Starting now");
}, 30000);
(async () => {
  setAuthMode("login");
  const params = new URL(window.location.href).searchParams;
  const reset = params.get("reset");
  if (reset) {
    state.resetToken = reset;
    showAuth();
    showAuthForm("reset-form");
    return;
  }
  if (state.token) {
    try {
      renderUserChip();
      showApp();
      if (state.user) { await loadClasses(); await renderPage(); if (navigator.onLine) flushOutbox(); }
    } catch {}
    bootApp();
  } else {
    showAuth();
  }
})();
