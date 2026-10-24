import type {
  ApiErrorResponse,
  AskResponse,
  ConnectRepositoryResponse,
  HealthResponse,
  ListFilesResponse,
  ReadFileResponse,
  SearchCodeResponse,
} from "../types/api";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "";

async function parseError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as ApiErrorResponse;
    if (body && typeof body.error === "string") return body.error;
  } catch {
    // Ignore JSON parse errors and fall back to a generic message.
  }
  return `Request failed with status ${response.status}`;
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, { signal });
  if (!response.ok) {
    throw new Error(await parseError(response));
  }
  return (await response.json()) as T;
}

export function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  return getJson<HealthResponse>("/api/health", signal);
}

export async function connectRepository(
  url: string,
  token?: string,
  signal?: AbortSignal,
): Promise<ConnectRepositoryResponse> {
  const body: { url: string; token?: string } = { url };
  if (token) body.token = token;
  const response = await fetch(`${API_BASE_URL}/api/repos`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    throw new Error(await parseError(response));
  }
  return (await response.json()) as ConnectRepositoryResponse;
}

export async function disconnectRepository(sessionId: string): Promise<void> {
  await fetch(`${API_BASE_URL}/api/repos/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
  });
}

export function listRepositoryFiles(
  sessionId: string,
  path?: string,
  signal?: AbortSignal,
): Promise<ListFilesResponse> {
  const query = path ? `?path=${encodeURIComponent(path)}` : "";
  return getJson<ListFilesResponse>(
    `/api/repos/${encodeURIComponent(sessionId)}/files${query}`,
    signal,
  );
}

export function searchRepositoryCode(
  sessionId: string,
  query: string,
  extension?: string,
  signal?: AbortSignal,
): Promise<SearchCodeResponse> {
  const params = new URLSearchParams({ q: query });
  if (extension) params.set("ext", extension);
  return getJson<SearchCodeResponse>(
    `/api/repos/${encodeURIComponent(sessionId)}/search?${params.toString()}`,
    signal,
  );
}

export function readRepositoryFile(
  sessionId: string,
  path: string,
  signal?: AbortSignal,
): Promise<ReadFileResponse> {
  return getJson<ReadFileResponse>(
    `/api/repos/${encodeURIComponent(sessionId)}/file?path=${encodeURIComponent(path)}`,
    signal,
  );
}

export async function askRepository(
  sessionId: string,
  question: string,
  signal?: AbortSignal,
): Promise<AskResponse> {
  const response = await fetch(`${API_BASE_URL}/api/repos/${encodeURIComponent(sessionId)}/ask`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question }),
    signal,
  });
  if (!response.ok) {
    throw new Error(await parseError(response));
  }
  return (await response.json()) as AskResponse;
}
