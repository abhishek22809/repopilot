import type { ConnectRepositoryResponse } from "../types/api";

interface RepositoryCardProps {
  data: ConnectRepositoryResponse;
  onDisconnect: () => void;
}

export default function RepositoryCard({ data, onDisconnect }: RepositoryCardProps) {
  const { repository, fileCount, expiresAt } = data;

  return (
    <section className="repo-card">
      <div className="repo-card__header">
        <h2 className="repo-card__name">
          {repository.fullName}
          {repository.private && <span className="repo-card__badge">Private</span>}
        </h2>
        <button type="button" className="repo-card__disconnect" onClick={onDisconnect}>
          Disconnect
        </button>
      </div>
      {repository.description && <p className="repo-card__description">{repository.description}</p>}
      <dl className="repo-card__meta">
        <div>
          <dt>Default branch</dt>
          <dd>{repository.defaultBranch}</dd>
        </div>
        <div>
          <dt>Files loaded</dt>
          <dd>{fileCount.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Session expires</dt>
          <dd>{new Date(expiresAt).toLocaleTimeString()}</dd>
        </div>
      </dl>
      <a className="repo-card__link" href={repository.htmlUrl} target="_blank" rel="noreferrer">
        View on GitHub ↗
      </a>
    </section>
  );
}
