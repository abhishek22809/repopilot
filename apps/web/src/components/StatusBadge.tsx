import type { ApiStatus } from "../types/api";

const LABELS: Record<ApiStatus, string> = {
  loading: "Checking API…",
  online: "API online",
  offline: "API offline",
};

interface StatusBadgeProps {
  status: ApiStatus;
}

export default function StatusBadge({ status }: StatusBadgeProps) {
  return <span className={`status-badge status-badge--${status}`}>{LABELS[status]}</span>;
}
