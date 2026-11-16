const { badRequest } = require("./errors");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value) => typeof value === "string" && UUID_RE.test(value);

// Reject malformed IDs in the URL with a 400 instead of letting PostgreSQL throw.
function uuidParams(router, ...names) {
  for (const name of names) {
    router.param(name, (_req, _res, next, value) =>
      isUuid(value) ? next() : next(badRequest("That link or identifier is not valid.")));
  }
}

function cleanText(value, label, max, { required = false } = {}) {
  if (value === undefined || value === null) value = "";
  if (typeof value !== "string") throw badRequest(`${label} must be text.`);
  const text = value.trim();
  if (required && !text) throw badRequest(`${label} is required.`);
  if (text.length > max) throw badRequest(`${label} must be ${max} characters or fewer.`);
  return text;
}

module.exports = { isUuid, uuidParams, cleanText };
