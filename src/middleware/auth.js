const jwt = require("jsonwebtoken");

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Please sign in first." });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });
    next();
  } catch {
    return res.status(401).json({ error: "Your session is invalid or expired. Please sign in again." });
  }
}

module.exports = { requireAuth };
