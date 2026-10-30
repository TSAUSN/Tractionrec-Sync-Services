"use strict";

/**
 * Structured logging. Cloud Logging parses a JSON line on stdout into a real
 * log entry, so `severity` and the rest of the object become queryable fields.
 */
function emit(severity, message, fields = {}) {
  process.stdout.write(JSON.stringify({ severity, message, ...fields }) + "\n");
}

module.exports = {
  info: (m, f) => emit("INFO", m, f),
  warn: (m, f) => emit("WARNING", m, f),
  error: (m, f) => emit("ERROR", m, f),
  debug: (m, f) => {
    if (process.env.LOG_LEVEL === "debug") {
      emit("DEBUG", m, f);
    }
  }
};
