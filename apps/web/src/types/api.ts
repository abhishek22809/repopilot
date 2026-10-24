export interface HealthResponse {
  status: "ok";
  service: string;
  timestamp: string;
}

export type ApiStatus = "loading" | "online" | "offline";

export interface RepositoryInfo {
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  htmlUrl: string;
  description: string | null;
  private: boolean;
}

export interface ConnectRepositoryResponse {
  sessionId: string;
  repository: RepositoryInfo;
  fileCount: number;
  createdAt: string;
  expiresAt: string;
}

export interface ApiErrorResponse {
  error: string;
}

export interface FileEntry {
  path: string;
  type: "file" | "dir";
}

export interface ListFilesResponse {
  directory: string;
  count: number;
  truncated: boolean;
  entries: FileEntry[];
}

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

export interface SearchCodeResponse {
  query: string;
  count: number;
  truncated: boolean;
  matches: SearchMatch[];
}

export interface ReadFileResponse {
  path: string;
  size: number;
  lineCount: number;
  content: string;
}

export interface AskSource {
  path: string;
  lines?: string;
}

export interface AskResponse {
  answer: string;
  sources: AskSource[];
  grounded: boolean;
  contextFiles: string[];
}

export type ConnectionState =
  | { status: "idle" }
  | { status: "connecting" }
  | { status: "connected"; data: ConnectRepositoryResponse }
  | { status: "error"; message: string };
