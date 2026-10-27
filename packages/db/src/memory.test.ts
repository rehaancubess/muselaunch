import { CreditBalance } from "@muselaunch/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { MemoryDb } from "./memory";
import { DbError } from "./types";

const actor = { actor: "user_1" };

describe("MemoryDb repository", () => {
  let db: MemoryDb;
  beforeEach(() => {
    db = new MemoryDb();
  });

  it("creates with system fields and schema defaults", async () => {
    const app = await db.ws("ws_a").collection("apps").create({ name: "Focus Timer" }, actor);
    expect(app.id).toMatch(/^app_/);
    expect(app.workspaceId).toBe("ws_a");
    expect(app.createdBy).toBe("user_1");
    expect(app.status).toBe("draft");
    expect(app.platforms).toEqual([]);
  });

  it("rejects invalid documents", async () => {
    await expect(db.ws("ws_a").collection("apps").create({ name: "" } as never, actor)).rejects.toBeInstanceOf(DbError);
  });

  it("isolates workspaces: same id is invisible across tenants", async () => {
    const a = await db.ws("ws_a").collection("apps").create({ name: "A" }, actor);
    expect(await db.ws("ws_b").collection("apps").get(a.id)).toBeNull();
    expect((await db.ws("ws_b").collection("apps").list()).items).toHaveLength(0);
    await expect(db.ws("ws_b").collection("apps").update(a.id, { name: "hijack" }, actor)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("protects system fields on update", async () => {
    const repo = db.ws("ws_a").collection("apps");
    const a = await repo.create({ name: "A" }, actor);
    const u = await repo.update(a.id, { name: "B", workspaceId: "ws_evil", id: "x" } as never, actor);
    expect(u.workspaceId).toBe("ws_a");
    expect(u.id).toBe(a.id);
    expect(u.name).toBe("B");
  });

  it("supports optimistic concurrency", async () => {
    const repo = db.ws("ws_a").collection("apps");
    const a = await repo.create({ name: "A" }, actor);
    await new Promise((r) => setTimeout(r, 2));
    await repo.update(a.id, { name: "B" }, actor);
    await expect(repo.update(a.id, { name: "C" }, { ...actor, expectedUpdatedAt: a.updatedAt })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("createIfAbsent is idempotent", async () => {
    const repo = db.ws("ws_a").collection("apps");
    const first = await repo.createIfAbsent({ id: "app_fixed", name: "A" }, actor);
    const second = await repo.createIfAbsent({ id: "app_fixed", name: "B" }, actor);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.entity.name).toBe("A");
  });

  it("paginates with cursors in order", async () => {
    const repo = db.ws("ws_a").collection("apps");
    for (let i = 0; i < 5; i++) await repo.create({ name: `App ${i}` }, actor);
    const p1 = await repo.list({ limit: 2, orderBy: { field: "createdAt", dir: "desc" } });
    const p2 = await repo.list({ limit: 2, orderBy: { field: "createdAt", dir: "desc" }, cursor: p1.nextCursor });
    const p3 = await repo.list({ limit: 2, orderBy: { field: "createdAt", dir: "desc" }, cursor: p2.nextCursor });
    const all = [...p1.items, ...p2.items, ...p3.items].map((a) => a.id);
    expect(new Set(all).size).toBe(5);
    expect(p3.nextCursor).toBeNull();
  });

  it("enforces declared composite indexes", async () => {
    const repo = db.ws("ws_a").collection("apps");
    await expect(repo.list({ where: [["status", "==", "draft"]], orderBy: { field: "name" } })).rejects.toMatchObject({ code: "MISSING_INDEX" });
    // declared: jobs(appId, createdAt desc)
    await expect(db.ws("ws_a").collection("jobs").list({ where: [["appId", "==", "app_1"]], orderBy: { field: "createdAt", dir: "desc" } })).resolves.toBeDefined();
  });

  it("transactions are atomic and require read-before-update", async () => {
    const ws = "ws_a";
    const now = new Date().toISOString();
    await db.ws(ws).state("billing.credits", CreditBalance).set({ workspaceId: ws, available: 10, reserved: 0, lifetimeGranted: 10, lifetimeConsumed: 0, periodStart: now, updatedAt: now });
    await expect(
      db.runTransaction(async (tx) => {
        const bal = await tx.getState(ws, "billing.credits", CreditBalance);
        tx.setState(ws, "billing.credits", CreditBalance, { ...bal!, available: 0 });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect((await db.ws(ws).state("billing.credits", CreditBalance).get())!.available).toBe(10);

    const app = await db.ws(ws).collection("apps").create({ name: "A" }, actor);
    await expect(db.runTransaction(async (tx) => tx.update(ws, "apps", app.id, { name: "B" }, actor))).rejects.toMatchObject({ code: "TX_READ_REQUIRED" });
  });

  it("rejects unknown collections", () => {
    expect(() => db.ws("ws_a").collection("secrets" as never)).toThrow(DbError);
  });

  it("watch emits updates", async () => {
    const repo = db.ws("ws_a").collection("apps");
    const a = await repo.create({ name: "A" }, actor);
    const seen: string[] = [];
    const off = repo.watch(a.id, (d) => d && seen.push(d.name));
    await new Promise((r) => setTimeout(r, 5));
    await repo.update(a.id, { name: "B" }, actor);
    off();
    expect(seen).toEqual(["A", "B"]);
  });
});
