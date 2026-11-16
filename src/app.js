const path = require("path");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const compression = require("compression");
const { types } = require("pg");
const { apiNotFound, errorHandler } = require("./middleware/errors");

// Return DATE columns (OID 1082) as plain "YYYY-MM-DD" strings instead of JS Dates,
// so calendar dates never shift by a day depending on the server's time zone.
types.setTypeParser(1082, (value) => value);

function createApp(pool, { rateLimiting = true } = {}) {
  const app = express();
  app.locals.db = pool;
  if (process.env.TRUST_PROXY) {
    app.set("trust proxy", /^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY);
  }

  const production = process.env.NODE_ENV === "production";
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "https://unpkg.com"],
        // the UI uses inline style="" attributes and Google Fonts
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: production ? [] : null
      }
    }
  }));

  app.use(compression());

  const origins = (process.env.CORS_ORIGIN || "").split(",").map((o) => o.trim()).filter(Boolean);
  if (origins.length) app.use(cors({ origin: origins }));
  else if (!production) app.use(cors());

  app.use(express.json({ limit: "200kb" }));
  // Disable static asset caching temporarily while diagnosing frontend layout
  // changes. Browsers should revalidate styles and scripts on every request.
  app.use(express.static(path.join(__dirname, "..", "public"), {
    setHeaders(res) {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
    }
  }));

  app.get("/api/health", async (_req, res) => {
    try {
      await pool.query("SELECT 1");
      res.json({ ok: true, database: "connected" });
    } catch {
      res.status(503).json({ ok: false, database: "unavailable" });
    }
  });

  if (rateLimiting) {
    const tooMany = { error: "Too many attempts. Please wait a few minutes and try again." };
    const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false, message: tooMany });
    const joinLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 40, standardHeaders: true, legacyHeaders: false, message: tooMany });
    const scanLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false, message: { error: "Too many scans. Please wait a few minutes and try again." } });
    // AI generation hits a paid external service, so keep it on a tighter leash than normal routes.
    const aiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 40, standardHeaders: true, legacyHeaders: false, message: { error: "You're using AI tools very quickly. Please wait a few minutes and try again." } });
    app.use(["/api/auth/login", "/api/auth/register", "/api/auth/password", "/api/auth/forgot", "/api/auth/reset"], authLimiter);
    app.use("/api/classes/join", joinLimiter);
    app.use(/^\/api\/class-data\/[^/]+\/schedules\/scan\/?$/, scanLimiter);
    app.use(/\/generate$/, aiLimiter);
    app.use(/^\/api\/ai\/[^/]+\/(assistant|study-plan)\/?$/, aiLimiter);
  }

  app.use("/api/auth", require("./routes/auth"));
  app.use("/api/classes", require("./routes/classes"));
  app.use("/api/class-data", require("./routes/classData"));
  app.use("/api/attendance", require("./routes/attendance"));
  app.use("/api/uploads", require("./routes/uploads"));
  app.use("/api/ai", require("./routes/ai"));
  app.use("/api/notifications", require("./routes/notifications"));
  app.use("/api/events", require("./routes/events"));
  app.use("/api", apiNotFound);

  app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "..", "public", "index.html")));
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
