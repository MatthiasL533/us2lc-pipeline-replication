const ERROR_CODES = {
  PLAN_VALIDATION_ERROR: "PLAN_VALIDATION_ERROR",
  REFERENCE_RESOLUTION_ERROR: "REFERENCE_RESOLUTION_ERROR",
  SEMANTIC_GUARD_ERROR: "SEMANTIC_GUARD_ERROR",
  SDK_WRITE_ERROR: "SDK_WRITE_ERROR",
  COMMIT_ERROR: "COMMIT_ERROR"
};

class PipelineError extends Error {
  constructor({ code, message, stage = "", details = null, cause = null }) {
    super(message || "Pipeline error");
    this.name = "PipelineError";
    this.code = code || ERROR_CODES.SDK_WRITE_ERROR;
    this.stage = stage || "";
    this.details = details;
    if (cause) {
      this.cause = cause;
    }
  }
}

function classifyErrorCode(stage = "", err = null) {
  const st = String(stage || "").toLowerCase();

  if (st === "validation" || st === "schemaValidation") {
    return ERROR_CODES.PLAN_VALIDATION_ERROR;
  }
  if (st === "verification") {
    return ERROR_CODES.REFERENCE_RESOLUTION_ERROR;
  }
  if (st.includes("semantic")) {
    return ERROR_CODES.SEMANTIC_GUARD_ERROR;
  }
  if (st === "commit") {
    return ERROR_CODES.COMMIT_ERROR;
  }

  const message = formatErrorForDisplay(err).toLowerCase();
  if (message.includes("semantic verification failed")) return ERROR_CODES.SEMANTIC_GUARD_ERROR;
  if (message.includes("verification failed")) return ERROR_CODES.REFERENCE_RESOLUTION_ERROR;
  if (message.includes("validation failed")) return ERROR_CODES.PLAN_VALIDATION_ERROR;

  return ERROR_CODES.SDK_WRITE_ERROR;
}

function wrapStageError(stage, err) {
  if (err instanceof PipelineError) {
    if (!err.stage) err.stage = stage;
    return err;
  }

  const code = classifyErrorCode(stage, err);
  const message = formatErrorForDisplay(err);
  return new PipelineError({
    code,
    stage,
    message,
    details: {
      raw: err && typeof err === "object" ? err : null
    },
    cause: err
  });
}

function formatErrorForDisplay(err) {
  if (!err) return "Unknown error";
  if (typeof err === "string") return err;
  if (err && err.message && typeof err.message === "string" && err.message.trim()) {
    const message = err.message.trim();
    if (message !== "[object Object]") {
      return message;
    }
  }

  const candidates = [];
  if (err.error) candidates.push(err.error);
  if (err.response && err.response.body) candidates.push(err.response.body);
  if (err.response) candidates.push(err.response);
  candidates.push(err);

  for (const candidate of candidates) {
    try {
      const json = JSON.stringify(candidate);
      if (json && json !== "{}") return json;
    } catch (_jsonErr) {
      // ignore
    }
  }

  try {
    return String(err);
  } catch (_stringErr) {
    return "Unknown error";
  }
}

function formatPipelineErrorForConsole(err) {
  const code = err && err.code ? err.code : ERROR_CODES.SDK_WRITE_ERROR;
  const stage = err && err.stage ? err.stage : "unknown";
  const message = formatErrorForDisplay(err);
  return `[${code}] [stage: ${stage}] ${message}`;
}

module.exports = {
  ERROR_CODES,
  PipelineError,
  classifyErrorCode,
  wrapStageError,
  formatErrorForDisplay,
  formatPipelineErrorForConsole
};
