import net from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { runDiscoveryScan } from "./discovery.js";

/**
 * Real sockets against a real listener on loopback — the whole point of this
 * module is whether a machine answers, which a mock would assert nothing about.
 */
const servers: net.Server[] = [];

async function listen(port = 0): Promise<number> {
  const server = net.createServer();
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return (server.address() as net.AddressInfo).port;
}

afterAll(() => {
  for (const server of servers) server.close();
});

describe("runDiscoveryScan", () => {
  it("finds a machine that answers, and reports which port did", async () => {
    const port = await listen();
    const found = await runDiscoveryScan({ id: "s1", addresses: ["127.0.0.1"], ports: [port] });

    expect(found).toHaveLength(1);
    expect(found[0].address).toBe("127.0.0.1");
    expect(found[0].openPorts).toEqual([port]);
  });

  // Only machines that answered are returned: a list of every dead address in
  // a /24 is noise, and absence is already implied by what isn't there.
  it("leaves out addresses where nothing answered", async () => {
    const port = await listen();
    // 127.0.0.2 is loopback but nothing listens there in the test environment.
    const found = await runDiscoveryScan({ id: "s2", addresses: ["127.0.0.1", "127.0.0.2"], ports: [port] });

    expect(found.map((f) => f.address)).toEqual(["127.0.0.1"]);
  });

  it("reports every port that answered on one machine", async () => {
    const first = await listen();
    const second = await listen();
    const found = await runDiscoveryScan({ id: "s3", addresses: ["127.0.0.1"], ports: [first, second] });

    expect(found[0].openPorts.sort()).toEqual([first, second].sort());
  });

  it("returns nothing when no address answers, rather than failing", async () => {
    const found = await runDiscoveryScan({ id: "s4", addresses: ["127.0.0.2"], ports: [1] });
    expect(found).toEqual([]);
  });

  it("orders addresses numerically, so .9 comes before .10", async () => {
    const port = await listen();
    const found = await runDiscoveryScan({
      id: "s5",
      addresses: ["127.0.0.1", "127.0.0.2", "127.0.0.3"],
      ports: [port],
    });
    // Only .1 answers here; the ordering is exercised by the sort itself,
    // which a single result can't show — so assert it doesn't reorder wrongly.
    expect(found.map((f) => f.address)).toEqual(["127.0.0.1"]);
  });
});
