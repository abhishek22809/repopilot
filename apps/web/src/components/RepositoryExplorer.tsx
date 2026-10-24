import { useEffect, useState, type FormEvent } from "react";
import {
  listRepositoryFiles,
  readRepositoryFile,
  searchRepositoryCode,
} from "../services/apiClient";
import type { FileEntry, ReadFileResponse, SearchMatch } from "../types/api";
import AskPanel from "./AskPanel";
import FileViewer from "./FileViewer";

interface RepositoryExplorerProps {
  sessionId: string;
  isPrivate?: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

export default function RepositoryExplorer({ sessionId, isPrivate = false }: RepositoryExplorerProps) {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [filesLoading, setFilesLoading] = useState(true);

  const [selected, setSelected] = useState<string | null>(null);
  const [file, setFile] = useState<ReadFileResponse | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);

  const [searchTerm, setSearchTerm] = useState("");
  const [matches, setMatches] = useState<SearchMatch[] | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);

  // Load the file list on mount. The parent remounts this component (keyed by
  // sessionId) when the connected repository changes, so initial state is fresh.
  useEffect(() => {
    const controller = new AbortController();
    listRepositoryFiles(sessionId, undefined, controller.signal)
      .then((data) => setFiles(data.entries.filter((e) => e.type === "file")))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setFilesError(errorMessage(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setFilesLoading(false);
      });
    return () => controller.abort();
  }, [sessionId]);

  async function openFile(path: string) {
    setSelected(path);
    setFileLoading(true);
    setFileError(null);
    setFile(null);
    try {
      setFile(await readRepositoryFile(sessionId, path));
    } catch (error: unknown) {
      setFileError(errorMessage(error));
    } finally {
      setFileLoading(false);
    }
  }

  async function runSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const term = searchTerm.trim();
    if (term === "") return;
    setSearching(true);
    setSearchError(null);
    setMatches(null);
    try {
      const data = await searchRepositoryCode(sessionId, term);
      setMatches(data.matches);
    } catch (error: unknown) {
      setSearchError(errorMessage(error));
    } finally {
      setSearching(false);
    }
  }

  return (
    <section className="explorer">
      <div className="explorer__sidebar">
        <form className="explorer__search" onSubmit={runSearch}>
          <input
            type="search"
            placeholder="Search code…"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            aria-label="Search code"
          />
          <button type="submit" disabled={searching || searchTerm.trim() === ""}>
            {searching ? "…" : "Search"}
          </button>
        </form>

        {searchError && <p className="explorer__error">{searchError}</p>}

        {matches !== null ? (
          <div className="explorer__results">
            <div className="explorer__heading">
              <span>Search results ({matches.length})</span>
              <button type="button" className="explorer__link" onClick={() => setMatches(null)}>
                Back to files
              </button>
            </div>
            {matches.length === 0 && <p className="explorer__muted">No matches.</p>}
            <ul className="explorer__list">
              {matches.map((match, index) => (
                <li key={`${match.path}:${match.line}:${index}`}>
                  <button type="button" onClick={() => openFile(match.path)}>
                    <span className="explorer__match-path">
                      {match.path}:{match.line}
                    </span>
                    <span className="explorer__match-text">{match.text.trim()}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="explorer__files">
            <div className="explorer__heading">Files ({files.length})</div>
            {filesLoading && <p className="explorer__muted">Loading files…</p>}
            {filesError && <p className="explorer__error">{filesError}</p>}
            <ul className="explorer__list">
              {files.map((entry) => (
                <li key={entry.path}>
                  <button
                    type="button"
                    className={selected === entry.path ? "is-active" : ""}
                    onClick={() => openFile(entry.path)}
                  >
                    {entry.path}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="explorer__main">
        <AskPanel sessionId={sessionId} isPrivate={isPrivate} onOpenSource={openFile} />
        <FileViewer file={file} loading={fileLoading} error={fileError} />
      </div>
    </section>
  );
}
