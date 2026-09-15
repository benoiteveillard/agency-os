import type { ApiError } from "../types.js";

export function ErrorState({
  error,
  onRetry,
}: {
  error: ApiError;
  onRetry: () => void;
}) {
  const isTransport = error.code === "network_error";
  return (
    <div className="state-card state-card--error" role="alert">
      <p className="state-card__title">
        {isTransport
          ? "Connection interrupted"
          : "The investigation could not complete"}
      </p>
      <p className="state-card__body">
        {isTransport
          ? "The connection to the server was lost partway through. This is a transport issue, not a finding about the project."
          : "Something went wrong while investigating this project. No verdict was produced."}
      </p>
      <div className="state-card__actions">
        <button type="button" className="btn btn-primary" onClick={onRetry}>
          Try again
        </button>
      </div>
    </div>
  );
}
