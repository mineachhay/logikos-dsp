import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";
import { seedAuthedAgent } from "../auth/agentFixtures.testutil.js";

describe("file ownership", () => {
  // Local changes carry no user — the OS notification doesn't have one — so
  // ownership is the only signal of a person there is. It is stored apart
  // from actorUser because it is a weaker claim: whose file it is, not who
  // did something.
  it("stores the owner an agent reports, without treating it as the actor", async () => {
    const app = await buildApp();
    const { agent, headers } = await seedAuthedAgent();

    const res = await app.inject({
      method: "POST",
      url: "/ingest/events",
      headers,
      payload: [
        {
          agentKey: agent.key,
          eventType: "created",
          path: "C:\\Users\\alice\\Pictures\\New Bitmap Image.bmp",
          owner: "WIN-HOST\\alice",
          occurredAt: new Date().toISOString(),
        },
      ],
    });

    expect(res.statusCode).toBe(200);
    const event = await prisma.fileEvent.findFirstOrThrow({ where: { path: { contains: "New Bitmap Image" } } });
    expect(event.ownerUser).toBe("WIN-HOST\\alice");
    expect(event.actorUser).toBeNull();
    await app.close();
  });

  it("is happy without one — a deletion, or a volume with no security", async () => {
    const app = await buildApp();
    const { agent, headers } = await seedAuthedAgent();

    const res = await app.inject({
      method: "POST",
      url: "/ingest/events",
      headers,
      payload: [{ agentKey: agent.key, eventType: "deleted", path: "E:\\gone.txt", occurredAt: new Date().toISOString() }],
    });

    expect(res.statusCode).toBe(200);
    const event = await prisma.fileEvent.findFirstOrThrow({ where: { path: "E:\\gone.txt" } });
    expect(event.ownerUser).toBeNull();
    await app.close();
  });
});
