import { describe, expect, it } from "vitest";
import { createAgentSession } from "./agentSession.js";

/** A fake backend: accepts exactly the most recently issued secret. */
function fakeBackend() {
  let issued = 0;
  let current = "";
  return {
    registrations: () => issued,
    register: async () => {
      issued++;
      current = `secret-${issued}`;
      return current;
    },
    rotateElsewhere: () => {
      issued++;
      current = `secret-${issued}`;
    },
    send: (authorization: string) =>
      Promise.resolve(new Response(null, { status: authorization === `Bearer ${current}` ? 200 : 401 })),
  };
}

describe("createAgentSession", () => {
  it("sends the secret from registration", async () => {
    const backend = fakeBackend();
    const session = createAgentSession({ register: backend.register, log: () => {} });
    await session.start();
    expect((await session.request(backend.send)).status).toBe(200);
    expect(backend.registrations()).toBe(1);
  });

  it("re-registers once on a 401 and retries with the new secret", async () => {
    const backend = fakeBackend();
    const session = createAgentSession({ register: backend.register, log: () => {} });
    await session.start();
    backend.rotateElsewhere(); // e.g. a database restore or another registrant

    expect((await session.request(backend.send)).status).toBe(200);
    expect(backend.registrations()).toBe(3);
  });

  it("shares one re-registration between concurrent 401s", async () => {
    const backend = fakeBackend();
    const session = createAgentSession({ register: backend.register, log: () => {} });
    await session.start();
    backend.rotateElsewhere();

    const results = await Promise.all([session.request(backend.send), session.request(backend.send)]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(backend.registrations()).toBe(3);
  });

  it("doesn't re-register again inside the throttle window", async () => {
    let t = 0;
    let registrations = 0;
    const session = createAgentSession({
      register: async () => `secret-${++registrations}`,
      now: () => t,
      minReregisterIntervalMs: 5_000,
      log: () => {},
    });
    const alwaysUnauthorized = () => Promise.resolve(new Response(null, { status: 401 }));
    await session.start();

    t = 1_000; // first 401 re-registers, even right after startup
    expect((await session.request(alwaysUnauthorized)).status).toBe(401);
    expect(registrations).toBe(2);

    t = 3_000; // still inside the window: give up without registering
    expect((await session.request(alwaysUnauthorized)).status).toBe(401);
    expect(registrations).toBe(2);

    t = 10_000;
    await session.request(alwaysUnauthorized);
    expect(registrations).toBe(3);
  });

  it("passes a 403 (revoked) straight through without re-registering", async () => {
    let registrations = 0;
    const session = createAgentSession({ register: async () => `s-${++registrations}`, log: () => {} });
    await session.start();
    const res = await session.request(() => Promise.resolve(new Response(null, { status: 403 })));
    expect(res.status).toBe(403);
    expect(registrations).toBe(1);
  });

  it("returns the original 401 when re-registration itself fails", async () => {
    let calls = 0;
    const session = createAgentSession({
      register: async () => {
        if (++calls > 1) throw new Error("agent revoked");
        return "s-1";
      },
      log: () => {},
    });
    await session.start();
    const res = await session.request(() => Promise.resolve(new Response(null, { status: 401 })));
    expect(res.status).toBe(401);
  });
});
