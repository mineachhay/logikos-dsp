import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "./db.js";
import { applyNotificationPolicy } from "./notificationPolicy.js";
import { invalidateSettings } from "./settings.js";

async function set(key: string, value: unknown) {
  await prisma.setting.upsert({ where: { key }, create: { key, value: value as never }, update: { value: value as never } });
  invalidateSettings();
}

async function alert(type: string, severity: string) {
  return prisma.alert.create({ data: { type: type as never, severity: severity as never, message: `${type} test` } });
}

afterEach(() => vi.restoreAllMocks());

describe("applyNotificationPolicy", () => {
  it("offers a notification for alerts at or above the configured severity", async () => {
    await set("notify.suggestFromSeverity", "MEDIUM");
    const medium = await alert("BULK_FILE_READ", "MEDIUM");
    const low = await alert("BULK_FILE_READ", "LOW");
    expect(await applyNotificationPolicy()).toMatchObject({ offered: 1 });
    expect(await prisma.responseAction.count({ where: { alertId: medium.id } })).toBe(1);
    expect(await prisma.responseAction.count({ where: { alertId: low.id } })).toBe(0);
    expect(await applyNotificationPolicy()).toMatchObject({ offered: 0 }); // not twice
  });

  it("sends the chosen alert types without approval, and leaves the rest pending", async () => {
    await set("notify.webhook.url", "https://hooks.example/alerts");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));
    const silent = await alert("AGENT_SILENT", "HIGH");
    const attack = await alert("RANSOMWARE_RATE", "CRITICAL");
    // One pass offers both and sends the automatic one straight away.
    expect(await applyNotificationPolicy()).toEqual({ offered: 2, sent: 1 });
    expect(await applyNotificationPolicy()).toEqual({ offered: 0, sent: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sent = await prisma.responseAction.findFirstOrThrow({ where: { alertId: silent.id } });
    expect(sent).toMatchObject({ status: "EXECUTED", approvedByUserId: null });
    expect(sent.resultMessage).toMatch(/^sent automatically/);
    expect((await prisma.responseAction.findFirstOrThrow({ where: { alertId: attack.id } })).status).toBe("PENDING");
  });

  it("holds automatic notifications during quiet hours", async () => {
    await set("notify.webhook.url", "https://hooks.example/alerts");
    await set("general.timeZone", "UTC");
    await set("notify.quietFrom", "00:00");
    await set("notify.quietUntil", "23:59");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));
    await alert("AGENT_SILENT", "HIGH");
    await applyNotificationPolicy(new Date("2026-09-28T12:00:00Z"));
    expect(await applyNotificationPolicy(new Date("2026-09-28T12:00:00Z"))).toMatchObject({ sent: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never sends the same notification twice when an admin approves at the same moment", async () => {
    await set("notify.webhook.url", "https://hooks.example/alerts");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));
    const silent = await alert("AGENT_SILENT", "HIGH");
    await applyNotificationPolicy();
    // An admin's approve claims it first (responseActions.ts does the same updateMany).
    await prisma.responseAction.updateMany({ where: { alertId: silent.id, status: "PENDING" }, data: { status: "APPROVED" } });
    expect(await applyNotificationPolicy()).toMatchObject({ sent: 0 });
  });
});
