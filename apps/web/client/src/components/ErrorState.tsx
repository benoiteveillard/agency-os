import type { ApiError } from "../types.js";
import { Icon } from "./Icon.js";

export function ErrorState({
  error,
  onRetry,
}: {
  error: ApiError;
  onRetry: () => void;
}) {
  const isTransport = error.code === "network_error";
  const isBusy = error.code === "demo_busy";
  return (
    <div className="run-failed" role="alert">
      <Icon name={isTransport ? "WifiOff" : "Cross"} />
      <h2>
        {isBusy
          ? "The demo is busy"
          : isTransport
            ? "The connection was interrupted"
            : "The investigation could not complete"}
      </h2>
      <p>
        {isBusy
          ? error.message
          : isTransport
            ? "The connection to the server was lost partway through. This says nothing about the project."
            : "Something went wrong while investigating. No verdict was produced, so treat the launch status as unknown."}
      </p>
      <button type="button" className="btn btn-primary" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}
