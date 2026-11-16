// One place that turns thrown errors into clean JSON responses.
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const badRequest = (message) => new HttpError(400, message);

// PostgreSQL error codes that mean "the client sent something unusable", not "the server broke".
const PG_ERRORS = {
  "22P02": [400, "One of the values has an invalid format."],
  "22007": [400, "That date or time is not valid."],
  "22008": [400, "That date or time is not valid."],
  "22001": [400, "One of the values is too long."],
  "23502": [400, "A required value is missing."],
  "23503": [400, "That item refers to something that no longer exists."],
  "23505": [409, "That item already exists."],
  "23514": [400, "One of the values is not allowed."]
};

function apiNotFound(_req, res) {
  res.status(404).json({ error: "That API endpoint does not exist." });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(error, _req, res, _next) {
  if (error instanceof HttpError) return res.status(error.status).json({ error: error.message });
  if (error.type === "entity.parse.failed") return res.status(400).json({ error: "The request body is not valid JSON." });
  if (error.type === "entity.too.large") return res.status(413).json({ error: "The request is too large." });
  if (error.name === "MulterError") {
    return res.status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400)
      .json({ error: error.code === "LIMIT_FILE_SIZE" ? "That file is too large to upload." : "That file could not be uploaded." });
  }
  const mapped = PG_ERRORS[error.code];
  if (mapped) return res.status(mapped[0]).json({ error: mapped[1] });
  console.error(error);
  res.status(500).json({
    error: process.env.NODE_ENV === "production"
      ? "Something went wrong. Please try again."
      : (error.message || "Internal server error.")
  });
}

module.exports = { HttpError, badRequest, apiNotFound, errorHandler };
