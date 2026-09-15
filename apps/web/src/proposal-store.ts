import type { AuditRecord, ProposedAction } from "@agency-os/shared";

export type ProposalDecision = "approve" | "reject";
export type ProposalStoreErrorCode =
  | "unknown_proposal"
  | "expired_proposal"
  | "proposal_in_progress"
  | "proposal_already_decided"
  | "proposal_execution_failed"
  | "proposal_store_full"
  | "duplicate_proposal";

export class ProposalStoreError extends Error {
  constructor(public readonly code: ProposalStoreErrorCode) {
    super(code);
    this.name = "ProposalStoreError";
  }
}

type Entry =
  | {
      state: "pending";
      action: ProposedAction;
      traceId: string;
      expiresAt: number;
    }
  | { state: "deciding"; decision: ProposalDecision }
  | {
      state: "decided";
      decision: ProposalDecision;
      audit: AuditRecord;
      forgetAt: number;
    }
  | { state: "failed"; decision: ProposalDecision; forgetAt: number }
  | { state: "expired"; forgetAt: number };

/** Single-process store. Restart loses proposals; never reconstruct one from client data. */
export class ProposalStore {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly retentionMs: number;
  private readonly maxEntries: number;

  constructor(
    options: {
      now?: () => number;
      ttlMs?: number;
      retentionMs?: number;
      maxEntries?: number;
    } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? 15 * 60_000;
    this.retentionMs = options.retentionMs ?? 15 * 60_000;
    this.maxEntries = options.maxEntries ?? 1_000;
    if (
      !Number.isFinite(this.ttlMs) ||
      this.ttlMs <= 0 ||
      !Number.isFinite(this.retentionMs) ||
      this.retentionMs <= 0 ||
      !Number.isSafeInteger(this.maxEntries) ||
      this.maxEntries <= 0
    ) {
      throw new Error("Invalid proposal store limits");
    }
  }

  insert(
    action: ProposedAction,
    investigationTraceId: string,
  ): { expiresAt: string } {
    this.cleanup();
    if (this.entries.has(action.id))
      throw new ProposalStoreError("duplicate_proposal");
    // Fail closed at capacity instead of evicting an approval or its retry guard.
    if (this.entries.size >= this.maxEntries)
      throw new ProposalStoreError("proposal_store_full");
    const expiresAt = this.now() + this.ttlMs;
    this.entries.set(action.id, {
      state: "pending",
      action: immutableCopy(action),
      traceId: investigationTraceId,
      expiresAt,
    });
    return { expiresAt: new Date(expiresAt).toISOString() };
  }

  async decide(
    id: string,
    decision: ProposalDecision,
    execute: (
      action: ProposedAction,
      investigationTraceId: string,
    ) => Promise<AuditRecord>,
  ): Promise<AuditRecord> {
    this.cleanup();
    const entry = this.entries.get(id);
    if (!entry) throw new ProposalStoreError("unknown_proposal");
    if (entry.state === "expired")
      throw new ProposalStoreError("expired_proposal");
    if (entry.state !== "pending") {
      if (entry.decision !== decision)
        throw new ProposalStoreError("proposal_already_decided");
      if (entry.state === "deciding")
        throw new ProposalStoreError("proposal_in_progress");
      if (entry.state === "failed")
        throw new ProposalStoreError("proposal_execution_failed");
      return entry.audit;
    }
    // This transition is synchronous and precedes even the callback invocation.
    this.entries.set(id, { state: "deciding", decision });
    try {
      const audit = immutableCopy(await execute(entry.action, entry.traceId));
      this.entries.set(id, {
        state: "decided",
        decision,
        audit,
        forgetAt: this.now() + this.retentionMs,
      });
      return audit;
    } catch {
      // An exception may have happened after a successful external write. Never retry it.
      this.entries.set(id, {
        state: "failed",
        decision,
        forgetAt: this.now() + this.retentionMs,
      });
      throw new ProposalStoreError("proposal_execution_failed");
    }
  }

  private cleanup(): void {
    const now = this.now();
    for (const [id, entry] of this.entries) {
      if (entry.state === "pending" && now >= entry.expiresAt) {
        const forgetAt = entry.expiresAt + this.retentionMs;
        if (now >= forgetAt) this.entries.delete(id);
        else this.entries.set(id, { state: "expired", forgetAt });
      } else if ("forgetAt" in entry && now >= entry.forgetAt) {
        this.entries.delete(id);
      }
    }
  }
}

function immutableCopy<T>(value: T): T {
  const copy = structuredClone(value);
  function freeze(item: unknown): void {
    if (item !== null && typeof item === "object") {
      for (const child of Object.values(item)) freeze(child);
      Object.freeze(item);
    }
  }
  freeze(copy);
  return copy;
}
