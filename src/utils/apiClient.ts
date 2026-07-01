export const API_BASE_URL = String(import.meta.env.VITE_API_BASE_URL || "").replace(/\/+$/, "");

console.log("API_BASE_URL", API_BASE_URL || "(same-origin)");

export function apiUrl(path: string) {
  if (/^https?:\/\//i.test(path)) return path;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${API_BASE_URL}${normalizedPath}`;
}

export async function apiFetch(path: string, init: RequestInit = {}, options: { timeoutMs?: number; retries?: number; endpointName?: string } = {}) {
  const timeoutMs = options.timeoutMs ?? 20000;
  const retries = options.retries ?? 1;
  const endpointName = options.endpointName || path;
  let lastError: any;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(apiUrl(path), {
        ...init,
        cache: init.cache ?? "no-store",
        signal: controller.signal,
      });
      window.clearTimeout(timeout);
      return res;
    } catch (error: any) {
      window.clearTimeout(timeout);
      lastError = error;
      if (attempt >= retries) break;
    }
  }

  if (lastError?.name === "AbortError") {
    throw new Error(`${endpointName} request timed out. Check backend/API port 3001.`);
  }
  throw new Error(`${endpointName} request failed. ${lastError?.message || "Check backend/API port 3001."}`);
}

export async function readJsonResponse(res: Response) {
  const text = await res.text();

  if (!res.ok) {
    throw new Error(`${res.url} failed with ${res.status}: ${text.slice(0, 200)}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${res.url} did not return JSON. First response chars: ${text.slice(0, 120)}`);
  }
}

export async function apiGetJson(path: string, options: { timeoutMs?: number; retries?: number; endpointName?: string } = {}) {
  return readJsonResponse(await apiFetch(path, undefined, options));
}

export async function apiHealthCheck() {
  return apiGetJson("/api/health", { timeoutMs: 5000, retries: 0, endpointName: "API health check" });
}

export function isDevTunnelHost() {
  return /devtunnels\.ms/i.test(window.location.hostname);
}
