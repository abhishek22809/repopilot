import { useEffect, useState } from "react";
import ConnectRepositoryForm from "../components/ConnectRepositoryForm";
import RepositoryCard from "../components/RepositoryCard";
import RepositoryExplorer from "../components/RepositoryExplorer";
import StatusBadge from "../components/StatusBadge";
import {
  connectRepository,
  disconnectRepository,
  fetchHealth,
} from "../services/apiClient";
import type { ApiStatus, ConnectionState } from "../types/api";

export default function HomePage() {
  const [apiStatus, setApiStatus] = useState<ApiStatus>("loading");
  const [connection, setConnection] = useState<ConnectionState>({ status: "idle" });

  useEffect(() => {
    const controller = new AbortController();
    fetchHealth(controller.signal)
      .then(() => setApiStatus("online"))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          console.error(error);
          setApiStatus("offline");
        }
      });
    return () => controller.abort();
  }, []);

  async function handleConnect(url: string, token?: string) {
    setConnection({ status: "connecting" });
    try {
      const data = await connectRepository(url, token);
      setConnection({ status: "connected", data });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Something went wrong.";
      setConnection({ status: "error", message });
    }
  }

  async function handleDisconnect() {
    if (connection.status === "connected") {
      void disconnectRepository(connection.data.sessionId);
    }
    setConnection({ status: "idle" });
  }

  return (
    <main className="page">
      <header className="page__header">
        <h1>RepoPilot — AI Repository Navigator</h1>
        <StatusBadge status={apiStatus} />
      </header>
      <p>Understand a GitHub repository faster. Public repos need no token; private repos need yours.</p>

      {connection.status === "connected" ? (
        <>
          <RepositoryCard data={connection.data} onDisconnect={handleDisconnect} />
          <RepositoryExplorer
            key={connection.data.sessionId}
            sessionId={connection.data.sessionId}
            isPrivate={connection.data.repository.private}
          />
        </>
      ) : (
        <>
          <ConnectRepositoryForm
            disabled={connection.status === "connecting"}
            error={connection.status === "error" ? connection.message : undefined}
            onConnect={handleConnect}
          />
        </>
      )}
    </main>
  );
}
