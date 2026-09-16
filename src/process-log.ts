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

export function formatUserNetworkError(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);
  if (/timed out after \d+ms/iu.test(raw)) {
    return "访问 GitHub 超时。请在「设置」打开系统代理并点击保存，或在「外部图库」关闭自动刷新。";
  }
  if (/ECONNRESET/u.test(raw)) {
    return "与 GitHub 的连接被重置。请检查网络，或在「设置」保存本机回环代理。";
  }
  if (/ECONNREFUSED/u.test(raw)) {
    return "无法连接代理。请确认「设置」中的本机回环地址正在监听。";
  }
  if (/ENOTFOUND|EAI_AGAIN/u.test(raw)) {
    return "无法解析 GitHub 地址。请检查网络，或在「设置」保存本机回环代理。";
  }
  if (/proxy CONNECT failed/iu.test(raw)) {
    return "本机代理拒绝了 CONNECT。请确认「设置」中的回环地址。";
  }
  if (/Provider source change plan failed/u.test(raw)) {
    return "图库来源更新失败。请检查网络或系统代理后，在「外部图库」重试。";
  }
  return raw;
}

export function processLogError(prefix: string, error?: unknown) {
  if (!enabled) return;
  const { message, hint } = error === undefined ? { message: prefix, hint: undefined } : describeNetworkFailure(error);
  const line = error === undefined || prefix.includes(message) ? prefix : `${prefix}: ${message}`;
  process.stderr.write(`[SFL] ${line}\n`);
  if (hint) process.stderr.write(`[SFL] ${hint}\n`);
}
