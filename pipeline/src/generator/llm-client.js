async function runFirstLlmPassStage({
  prompt,
  model,
  ollamaUrl,
  mockOllamaResponsePath,
  fetchImpl,
  ollamaOptions,
  llmRetries = 0,
  llmRetryDelayMs = 0,
  loadMockGeneratedPlan,
  callOllamaGenerate,
  progress
}) {
  progress(
    mockOllamaResponsePath
      ? "Stage 6/10: LLM first pass using mock response..."
      : `Stage 6/10: LLM first pass calling Ollama model ${model} at ${ollamaUrl}...`
  );

  if (mockOllamaResponsePath) {
    return {
      llmResult: loadMockGeneratedPlan(mockOllamaResponsePath),
      llmPassCount: 1,
      llmCallWarnings: []
    };
  }

  return {
    llmResult: await callWithRetries({
      label: "LLM first pass",
      attempts: Number(llmRetries) + 1,
      retryDelayMs: llmRetryDelayMs,
      progress,
      fn: () => callOllamaGenerate({
        prompt,
        model,
        ollamaUrl,
        fetchImpl,
        ollamaOptions
      })
    }),
    llmPassCount: 1,
    llmCallWarnings: []
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callWithRetries({ label, attempts, retryDelayMs, progress, fn }) {
  const maxAttempts = Math.max(1, Number.isFinite(Number(attempts)) ? Math.floor(Number(attempts)) : 1);
  const delayMs = Math.max(0, Number.isFinite(Number(retryDelayMs)) ? Math.floor(Number(retryDelayMs)) : 0);
  let lastErr = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= maxAttempts) break;
      if (typeof progress === "function") {
        progress(`${label} failed on attempt ${attempt}/${maxAttempts}: ${err && err.message ? err.message : String(err)}; retrying...`);
      }
      if (delayMs > 0) await sleep(delayMs);
    }
  }

  throw lastErr;
}

async function runRepairLlmPassStage({
  stories,
  coverage,
  currentPlan,
  appContext,
  model,
  ollamaUrl,
  fetchImpl,
  ollamaOptions,
  llmRetries = 0,
  llmRetryDelayMs = 0,
  buildRepairPrompt,
  callOllamaGenerate,
  progress
}) {
  progress(
    `Stage 6/10: LLM repair pass for ${coverage.missingStories.length} uncovered stor${coverage.missingStories.length === 1 ? "y" : "ies"}...`
  );

  const repairPrompt = buildRepairPrompt({
    stories,
    missingStories: coverage.missingStories,
    currentPlan,
    appContext
  });

  return callWithRetries({
    label: "LLM repair pass",
    attempts: Number(llmRetries) + 1,
    retryDelayMs: llmRetryDelayMs,
    progress,
    fn: () => callOllamaGenerate({
      prompt: repairPrompt,
      model,
      ollamaUrl,
      fetchImpl,
      ollamaOptions
    })
  });
}

async function runSectionLlmStage({
  stageName,
  prompt,
  schema,
  model,
  ollamaUrl,
  fetchImpl,
  ollamaOptions,
  llmRetries = 0,
  llmRetryDelayMs = 0,
  callOllamaGenerate,
  progress
}) {
  progress(`${stageName} calling Ollama model ${model} at ${ollamaUrl}...`);
  try {
    return await callWithRetries({
      label: stageName,
      attempts: Number(llmRetries) + 1,
      retryDelayMs: llmRetryDelayMs,
      progress,
      fn: () => callOllamaGenerate({
        prompt,
        model,
        ollamaUrl,
        fetchImpl,
        format: schema,
        ollamaOptions
      })
    });
  } catch (err) {
    throw new Error(`${stageName} failed after retries: ${err && err.message ? err.message : String(err)}`);
  }
}

module.exports = {
  callWithRetries,
  runFirstLlmPassStage,
  runRepairLlmPassStage,
  runSectionLlmStage
};
