const { HttpError } = require("./middleware/errors");

// Thin wrapper around the Gemini generateContent API. Every AI feature in the app goes through
// callModel so retries, error messages and JSON parsing stay in one place.
const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
const THINKING_LEVEL = process.env.GEMINI_THINKING_LEVEL || "low";
const TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS) || 60000;
const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

const NOT_CONFIGURED = "AI features aren't configured yet. Add a GEMINI_API_KEY to the server.";
const BUSY = "The AI is busy right now. Please try again in a moment.";

async function callModel(parts, { schema, temperature = 0.2 } = {}) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new HttpError(503, NOT_CONFIGURED);

  // "low" thinking keeps Flash fast; 3.8-flash could take 90s+ on a tiny prompt.
  const generationConfig = { responseMimeType: "application/json", temperature, thinkingConfig: { thinkingLevel: THINKING_LEVEL } };
  if (schema) generationConfig.responseSchema = schema;
  const body = JSON.stringify({ contents: [{ role: "user", parts }], generationConfig });

  // The model occasionally returns a transient "high demand" 500/503; retry a couple of times.
  let response, payload;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
    try {
      response = await fetch(`${ENDPOINT}/${MODEL}:generateContent?key=${encodeURIComponent(key)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
      if (error.name === "TimeoutError" || error.name === "AbortError") throw new HttpError(504, "The AI took too long to respond. Please try again.");
      throw new HttpError(502, "Couldn't reach the AI service. Check the server's internet connection.");
    }
    payload = await response.json().catch(() => ({}));
    if (response.ok || (response.status !== 500 && response.status !== 503)) break;
  }

  if (!response.ok) {
    if (response.status === 429 || response.status === 500 || response.status === 503) throw new HttpError(503, BUSY);
    throw new HttpError(502, payload?.error?.message || "The AI service rejected the request.");
  }

  const raw = (payload?.candidates?.[0]?.content?.parts || []).map((p) => p.text).filter(Boolean).join("");
  try { return JSON.parse(raw); } catch { throw new HttpError(502, "The AI returned something unreadable. Please try again."); }
}

/* ---------------- schedule scanning ---------------- */

const SCHEDULE_SCHEMA = {
  type: "object",
  properties: {
    schedule_title: { type: "string" },
    start_date: { type: "string" },
    end_date: { type: "string" },
    entries: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          subject: { type: "string" },
          day: { type: "string" },
          start_time: { type: "string" },
          end_time: { type: "string" },
          room: { type: "string" }
        },
        required: ["title", "day", "start_time", "end_time"]
      }
    }
  },
  required: ["entries"]
};

const SCHEDULE_INSTRUCTIONS = `You extract a class schedule from a student's timetable, given as an image or text.
Return every recurring class meeting as one entry. If the source explicitly names a temporary schedule or date range, also return schedule_title, start_date, and end_date (dates as YYYY-MM-DD); otherwise return empty strings for those fields.
- title: the class or subject name exactly as written.
- subject: a short subject name to group by; reuse the title if unsure.
- day: one full English weekday (Sunday, Monday, ... Saturday). If a row lists several days (e.g. MWF), emit one entry per day.
- start_time / end_time: 24-hour "HH:MM". Convert 12-hour times (1:30 PM becomes 13:30).
- room: the room or location, or "" when there is none.
Ignore headers, breaks, lunch periods, and any row that is not a class. If nothing readable is found, return an empty list.`;

async function scanSchedule({ text, image }) {
  const parts = [{ text: SCHEDULE_INSTRUCTIONS }];
  if (text) parts.push({ text: `Schedule text:\n${text}` });
  if (image) parts.push({ inline_data: { mime_type: image.mimeType, data: image.buffer.toString("base64") } });
  const parsed = await callModel(parts, { schema: SCHEDULE_SCHEMA });
  return { entries: Array.isArray(parsed?.entries) ? parsed.entries : [], schedule_title: parsed?.schedule_title || "", start_date: parsed?.start_date || "", end_date: parsed?.end_date || "" };
}

/* ---------------- reviewer generation ---------------- */

const REVIEWER_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    content: { type: "string" }
  },
  required: ["title", "content"]
};

const REVIEWER_INSTRUCTIONS = `You are a study assistant. Turn the supplied class material into a COMPACT, exam-ready reviewer.
Rules:
- Output GitHub-flavoured Markdown only (no LaTeX, no code fences around the whole thing).
- Start with a one-line "In a nutshell" summary, then "## Key concepts" as short bullets.
- Keep it straight to the point: short bullets, no filler, no repetition, no "the text says".
- Use "## " headings for major sections, "- " for bullets, "**bold**" for key terms.
- Prefer definitions, formulas, lists and contrasts (e.g. "X vs Y").
- If a term list is useful, add a "## Key terms" section with "Term — definition" lines.
- Target roughly 300-600 words unless the material is very large.
- Synthesize slide material into coherent Markdown sections; merge repeated headers and ignore slide numbers, footers, and extraction artifacts.
- Return only the reviewer content and title in the requested fields. Never repeat these instructions or conversational framing.
- title: a short, specific reviewer title (max 90 characters) based on the material.`;

async function generateReviewer({ text, inline, hint }) {
  const parts = [{ text: REVIEWER_INSTRUCTIONS }];
  if (hint) parts.push({ text: `Context: ${hint}` });
  if (text) parts.push({ text: `Class material:\n${text}` });
  if (inline) parts.push({ inline_data: { mime_type: inline.mimeType, data: inline.buffer.toString("base64") } });
  if (!text && !inline) throw new HttpError(400, "Add a file first.");
  const parsed = await callModel(parts, { schema: REVIEWER_SCHEMA });
  const title = String(parsed?.title || "").trim().replace(/^(?:Here(?:'s| is) (?:your|the) )/i, "").slice(0, 90) || "AI reviewer";
  const content = String(parsed?.content || "").trim()
    .replace(/^(?:Here(?:'s| is) (?:your|the) (?:reviewer|study guide)[^\n]*\n+|As an AI[^\n]*\n+)/i, "")
    .split(/\r?\n/)
    .filter((line) => !/^(?:You are a study assistant|Rules:|Output GitHub-flavoured Markdown only|Start with a one-line|Keep it straight to the point|Use "## " headings|Prefer definitions, formulas|If a term list is useful|Target roughly|title: a short, specific reviewer title)/i.test(line.trim()))
    .join("\n").trim();
  if (!content) throw new HttpError(502, "The AI couldn't build a reviewer from that material. Try clearer material.");
  return { title, content };
}

/* ---------------- quiz generation ---------------- */

const QUIZ_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          question: { type: "string" },
          options: { type: "array", items: { type: "string" } },
          answer: { type: "integer" },
          explanation: { type: "string" }
        },
        required: ["question", "options", "answer", "explanation"]
      }
    }
  },
  required: ["questions"]
};

const QUIZ_INSTRUCTIONS = `You write multiple-choice quizzes from a student's reviewer notes.
Rules:
- Write exactly the requested number of questions.
- Each question has exactly 4 plausible options; only one is correct.
- "answer" is the 0-based index of the correct option.
- "explanation" is one short sentence saying why the answer is right.
- Cover the material evenly and test understanding, not trivia. Keep questions self-contained.
- Plain text only (no LaTeX, no markdown syntax inside options).`;

async function generateQuiz({ notes, count = 5, difficulty = "medium" }) {
  const context = notes.map((n) => `### ${n.title}\n${n.content}`).join("\n\n").slice(0, 120000);
  if (!context.trim()) throw new HttpError(400, "Those topics have no reviewers to quiz yet.");
  const parts = [
    { text: QUIZ_INSTRUCTIONS },
    { text: `Difficulty: ${difficulty}. Number of questions: ${count}.` },
    { text: `Reviewer material:\n${context}` }
  ];
  const parsed = await callModel(parts, { schema: QUIZ_SCHEMA, temperature: 0.4 });
  const questions = normalizeQuestions(parsed?.questions);
  if (!questions.length) throw new HttpError(502, "The AI couldn't build a quiz from those topics.");
  return { title: String(parsed?.title || "").trim().slice(0, 120) || "AI quiz", questions, difficulty };
}

// Keep only well-formed questions: 2-6 unique options and a valid answer index.
function normalizeQuestions(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((q) => {
    const options = Array.isArray(q?.options) ? q.options.map((o) => String(o).trim()).filter(Boolean).slice(0, 6) : [];
    const answer = Number(q?.answer);
    if (!q?.question || options.length < 2 || !Number.isInteger(answer) || answer < 0 || answer >= options.length) return null;
    return {
      question: String(q.question).trim().slice(0, 500),
      options,
      answer,
      explanation: String(q.explanation || "").trim().slice(0, 400)
    };
  }).filter(Boolean).slice(0, 30);
}

/* ---------------- study planner ---------------- */

const STUDY_PLAN_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
    sessions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          day: { type: "string" },
          start_time: { type: "string" },
          end_time: { type: "string" },
          subject: { type: "string" },
          focus: { type: "string" },
          note: { type: "string" }
        },
        required: ["day", "start_time", "end_time", "subject", "focus"]
      }
    }
  },
  required: ["sessions"]
};

const STUDY_PLAN_INSTRUCTIONS = `You plan a realistic study week for a student.
You are given the student's class times and their upcoming deadlines. Build study sessions that:
- Never overlap a class the student already has that day (class times are listed).
- Prioritise subjects with the nearest deadlines.
- Spread work across the week; prefer 30-90 minute blocks in the evening or free mornings.
- Keep it light: at most two sessions per day and at most about ten for the week.
- "day": one full English weekday. "start_time"/"end_time": 24-hour "HH:MM".
- "subject": the subject to study. "focus": a short, specific goal (e.g. "Review Chapter 3 + practice 5 problems").
- "note": an optional one-line tip, or "" .
Also return "title" (short) and "summary" (2-3 sentences on the plan's priorities).
If there is nothing to study, return an empty sessions list.`;

async function generateStudyPlan({ schedule, tasks, subjects }) {
  const parts = [{ text: STUDY_PLAN_INSTRUCTIONS }];
  parts.push({ text: `Class times:\n${schedule || "No classes scheduled."}` });
  parts.push({ text: `Upcoming deadlines:\n${tasks || "No upcoming deadlines."}` });
  parts.push({ text: `Subjects: ${subjects || "none listed"}` });
  const parsed = await callModel(parts, { schema: STUDY_PLAN_SCHEMA, temperature: 0.5 });
  const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const byLower = new Map(DAY_NAMES.map((d) => [d.toLowerCase(), d]));
  const sessions = (Array.isArray(parsed?.sessions) ? parsed.sessions : []).map((s) => {
    const day = byLower.get(String(s?.day || "").trim().toLowerCase());
    const start = String(s?.start_time || "").trim();
    const end = String(s?.end_time || "").trim();
    const subject = String(s?.subject || "").trim();
    const focus = String(s?.focus || "").trim();
    if (!day || !/^([01]\d|2[0-3]):[0-5]\d$/.test(start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(end) || !focus) return null;
    return { day, start_time: start, end_time: end, subject: subject.slice(0, 120), focus: focus.slice(0, 300), note: String(s?.note || "").trim().slice(0, 200) };
  }).filter(Boolean).slice(0, 20);
  return {
    title: String(parsed?.title || "").trim().slice(0, 180) || "Your study week",
    summary: String(parsed?.summary || "").trim().slice(0, 800),
    sessions
  };
}

/* ---------------- class assistant ---------------- */

const ASSISTANT_SCHEMA = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"]
};

const ASSISTANT_INSTRUCTIONS = `You are ClasslieAI, a friendly study assistant inside a student's classroom app.
You are given a complete snapshot of the active class: attendance and absences, regular and temporary schedules, tasks, events, subjects, topics and reviewer contents. It includes the requesting user’s attendance details and, for owners/admins, overall class attendance statistics.
Rules:
- The snapshot starts with "Now:" (the student's local date/time and timezone), "Currently in class" when a class is in progress, and "Upcoming classes" for the next 7 days. Use these for questions like "what's next?", "next subject?", or "anong susunod?" — never say you don't know the current time or day when it is in the snapshot.
- Trust the "Now:" line even if an earlier chat message claims you don't know the time or day; older messages may predate the current snapshot.
- Answer questions about attendance, absence and late dates, subjects, schedules, events, tasks, topics and reviewer contents directly from the snapshot.
- Answer ONLY from the class snapshot provided. If something isn't there, say so plainly — never invent tasks, dates, grades or people.
- You are read-only: you cannot create, edit or delete anything. If the student asks you to, explain how they can do it themselves in the app.
- Be concise and practical. Use short Markdown (bold, bullet lists) when it helps.
- You may explain concepts, summarise reviewers, suggest a study order, or draft text for the student to copy.
- Return your reply in "answer" as Markdown.`;

async function askClasslie({ question, history, context }) {
  const parts = [{ text: ASSISTANT_INSTRUCTIONS }, { text: `Class snapshot:\n${context || "No class data available."}` }];
  const recent = Array.isArray(history) ? history.slice(-6) : [];
  if (recent.length) {
    parts.push({ text: `Earlier in this chat:\n${recent.map((m) => `${m.role === "user" ? "Student" : "ClasslieAI"}: ${String(m.content || "").slice(0, 800)}`).join("\n")}` });
  }
  parts.push({ text: `Student: ${String(question || "").slice(0, 2000)}` });
  const parsed = await callModel(parts, { schema: ASSISTANT_SCHEMA, temperature: 0.4 });
  const answer = String(parsed?.answer || "").trim();
  if (!answer) throw new HttpError(502, "The assistant couldn't answer that. Please try again.");
  return answer;
}

module.exports = { scanSchedule, generateReviewer, generateQuiz, generateStudyPlan, askClasslie, normalizeQuestions };
