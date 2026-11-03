import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AuditLogEntry } from "@agency-os/shared";
import { createFileAuditLog } from "./index.js";

const entry = (approvalTraceId: string): AuditLogEntry =>
  ({
    event: "result",
    at: "2026-11-02T00:00:00.000Z",
    audit: {},
    investigationTraceId: "i",
    approvalTraceId,
  }) as AuditLogEntry;

describe("createFileAuditLog", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true })));
    dirs.length = 0;
  });
  async function logPath() {
    const dir = await mkdtemp(path.join(tmpdir(), "audit-"));
    dirs.push(dir);
    return path.join(dir, "nested/decisions.jsonl");
  }

  it("creates the directory and appends one JSON line per entry", async () => {
    const file = await logPath();
    const log = createFileAuditLog(file);
    await log.append(entry("a"));
    await log.append(entry("b"));
    const lines = (await readFile(file, "utf-8")).trim().split("\n");
    expect(lines.map((line) => JSON.parse(line).approvalTraceId)).toEqual([
      "a",
      "b",
    ]);
  });

  it("is readable by its owner only, since it holds proposal text", async () => {
    const file = await logPath();
    await createFileAuditLog(file).append(entry("a"));
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("rejects when it can't write, so callers can refuse to execute", async () => {
    const file = await logPath();
    await expect(
      createFileAuditLog(path.join(file, "\0bad")).append(entry("a")),
    ).rejects.toThrow();
  });
});
