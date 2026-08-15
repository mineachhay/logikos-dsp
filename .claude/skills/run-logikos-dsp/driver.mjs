#!/usr/bin/env node
// Minimal chromium-cli-alike REPL driver, used because chromium-cli itself
// isn't installed in this environment. Reads newline-delimited commands from
// stdin, drives a headless Chrome (the system /usr/bin/google-chrome, so no
// Playwright browser download is needed), and writes numbered screenshots to
// ./screenshots/ next to this file.
//
// Commands (one per line):
//   nav <url>
//   wait-for text=<substring> | <css selector>   (default timeout 15s)
//   click <css selector>
//   fill <css selector> <text...>
//   press <key>                                  (e.g. Enter)
//   eval <js expression>                          (runs in page context)
//   screenshot [name]
//   console                                       (dump buffered console/page errors)
//   quit

import { chromium } from "playwright-core";
import { createInterface } from "node:readline";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const shotDir = join(here, "screenshots");
mkdirSync(shotDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: "/usr/bin/google-chrome",
  args: ["--no-sandbox", "--disable-gpu"],
  headless: true,
});
const page = await browser.newPage();
const logs = [];
page.on("console", (msg) => logs.push(`[console:${msg.type()}] ${msg.text()}`));
page.on("pageerror", (err) => logs.push(`[pageerror] ${err.message}`));

let shotN = 0;

function parseLine(line) {
  const sp = line.indexOf(" ");
  if (sp === -1) return [line, ""];
  return [line.slice(0, sp), line.slice(sp + 1)];
}

async function waitFor(arg) {
  if (arg.startsWith("text=")) {
    const text = arg.slice("text=".length);
    await page.getByText(text).first().waitFor({ timeout: 15000 });
  } else {
    await page.waitForSelector(arg, { timeout: 15000 });
  }
}

const rl = createInterface({ input: process.stdin, terminal: false });
for await (const raw of rl) {
  const line = raw.trim();
  if (!line || line.startsWith("#")) continue;
  const [cmd, arg] = parseLine(line);
  try {
    if (cmd === "nav") {
      await page.goto(arg, { waitUntil: "domcontentloaded" });
      console.log(`ok nav ${arg}`);
    } else if (cmd === "wait-for") {
      await waitFor(arg);
      console.log(`ok wait-for ${arg}`);
    } else if (cmd === "click") {
      await page.click(arg);
      console.log(`ok click ${arg}`);
    } else if (cmd === "fill") {
      const sp = arg.indexOf(" ");
      const sel = arg.slice(0, sp);
      const text = arg.slice(sp + 1);
      await page.fill(sel, text);
      console.log(`ok fill ${sel}`);
    } else if (cmd === "press") {
      await page.keyboard.press(arg);
      console.log(`ok press ${arg}`);
    } else if (cmd === "eval") {
      const result = await page.evaluate(arg);
      console.log(`ok eval => ${JSON.stringify(result)}`);
    } else if (cmd === "screenshot") {
      shotN += 1;
      const name = arg ? `${arg}.png` : `${String(shotN).padStart(2, "0")}.png`;
      const path = join(shotDir, name);
      await page.screenshot({ path, fullPage: true });
      console.log(`ok screenshot ${path}`);
    } else if (cmd === "console") {
      console.log(logs.length ? logs.join("\n") : "(no console output buffered)");
    } else if (cmd === "quit") {
      break;
    } else {
      console.log(`err unknown command: ${cmd}`);
    }
  } catch (err) {
    console.log(`err ${cmd}: ${err.message.split("\n")[0]}`);
  }
}

await browser.close();
