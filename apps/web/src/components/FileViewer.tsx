import type { ReadFileResponse } from "../types/api";

interface FileViewerProps {
  file: ReadFileResponse | null;
  loading: boolean;
  error: string | null;
}

export default function FileViewer({ file, loading, error }: FileViewerProps) {
  if (loading) return <div className="viewer viewer--empty">Loading file…</div>;
  if (error) return <div className="viewer viewer--error">{error}</div>;
  if (!file) return <div className="viewer viewer--empty">Select a file to view its contents.</div>;

  const lines = file.content.split("\n");

  return (
    <div className="viewer">
      <div className="viewer__path" title={file.path}>
        {file.path}
      </div>
      <pre className="viewer__code">
        <code>
          {lines.map((line, index) => (
            <span className="viewer__line" key={index}>
              <span className="viewer__ln">{index + 1}</span>
              <span className="viewer__lc">{line || " "}</span>
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}
