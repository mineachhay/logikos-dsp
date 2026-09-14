// Minimal receiver for RESPONSE_WEBHOOK_URL, for deployments that don't have a
// real Slack/Telegram endpoint wired up yet.
//
// Without something listening, approving a WEBHOOK_NOTIFICATION response action
// goes straight to FAILED (backend/src/responseActions/webhook.ts POSTs
// synchronously and records the result) — so the approve/execute half of the
// feature can't be exercised at all. This accepts the POST, logs the payload,
// and returns 200, which both makes approvals succeed and documents the exact
// payload shape you'd need to adapt for a real webhook target.
//
// Deliberately dependency-free: it runs on a bare node image with no install.
import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 9099);

createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405).end("method not allowed\n");
    return;
  }
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    let rendered = body;
    try { rendered = JSON.stringify(JSON.parse(body), null, 2); } catch { /* log raw */ }
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}\n${rendered}`);
    res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}\n');
  });
}).listen(port, "0.0.0.0", () => console.log(`webhook logger listening on :${port}`));
