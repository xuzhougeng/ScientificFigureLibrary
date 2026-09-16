let enabled = false;

export function enableProcessLog() {
  enabled = true;
}

export function resetProcessLogForTests() {
  enabled = false;
}

export function processLogEnabled() {
  return enabled;
}

export function describeNetworkFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/timed out after \d+ms/iu.test(message)) {
    return {
      message,
      hint: "GitHub timed out. Enable the loopback proxy in Settings, or disable auto-refresh in External galleries.",
    };
  }
  if (/ECONNRESET/u.test(message)) {
    return {
      message,
      hint: "Connection to GitHub was reset. Check the network or the loopback proxy in Settings.",
    };
  }
  if (/ECONNREFUSED/u.test(message)) {
    return {
      message,
      hint: "Connection refused. If a proxy is enabled, confirm the loopback address is listening.",
    };
  }
  if (/ENOTFOUND|EAI_AGAIN/u.test(message)) {
    return {
      message,
      hint: "DNS lookup for GitHub failed. Check the network or the loopback proxy in Settings.",
    };
  }
  if (/proxy CONNECT failed/iu.test(message)) {
    return {
      message,
      hint: "The loopback proxy rejected CONNECT. Confirm the address in Settings.",
    };
  }
  return { message, hint: undefined };
}

export function processLogError(prefix: string, error?: unknown) {
  if (!enabled) return;
  const { message, hint } = error === undefined ? { message: prefix, hint: undefined } : describeNetworkFailure(error);
  const line = error === undefined || prefix.includes(message) ? prefix : `${prefix}: ${message}`;
  process.stderr.write(`[SFL] ${line}\n`);
  if (hint) process.stderr.write(`[SFL] ${hint}\n`);
}
