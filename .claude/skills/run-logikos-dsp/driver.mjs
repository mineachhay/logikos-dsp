#!/usr/bin/env node
// Minimal chromium-cli-alike REPL driver, used because chromium-cli itself
// isn't installed in this environment. Reads newline-delimited commands from
// stdin, drives a headless Chromium, and writes numbered screenshots to
// ./screenshots/ next to this file.
//
// Browser resolution, in order:
//   1. $CHROME_PATH                        (explicit override)
//   2. /usr/bin/google-chrome              (system Chrome, if present)
//   3. Playwright's own downloaded Chromium (~/.cache/ms-playwright)
// Install (3) with:
//   PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64 npx playwright-core install chromium
// The override is required on Ubuntu 26.04 — see SKILL.md Gotchas.
//
// Commands (one per line):
//   nav <url>
//   wait-for text=<substring> | <css selector>   (default timeout 15s)
//   click <css selector>
//   fill <css selector> <text...>
//   press <key>                                  (e.g. Enter)
//   eval <js expression>                          (runs in page context)
//   viewport <width>x<height>                    (e.g. 390x844 for a phone; default 1280x720)
//   screenshot [name]
//   console                                       (dump buffered console/page errors)
//   quit

import { chromium } from "playwright-core";
import { createInterface } from "node:readline";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const shotDir = join(here, "screenshots");
mkdirSync(shotDir, { recursive: true });

function resolveExecutable() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  if (existsSync("/usr/bin/google-chrome")) return "/usr/bin/google-chrome";
  return undefined; // let playwright-core use its own downloaded browser
}

// On a container with no root, Chromium's ~12 shared-library deps and its
// fonts are unpacked into ~/.local/chrome-deps from plain .deb files (see
// SKILL.md Prerequisites). Point the browser process at them. Harmless when
// the directory doesn't exist — a distro-packaged Chrome finds its own libs.
function browserEnv() {
  const deps = join(process.env.HOME ?? "", ".local/chrome-deps");
  if (!existsSync(deps)) return process.env;
  const libs = [
    join(deps, "usr/lib/x86_64-linux-gnu"),
    join(deps, "lib/x86_64-linux-gnu"),
  ].join(":");
  return {
    ...process.env,
    LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH ? `${libs}:${process.env.LD_LIBRARY_PATH}` : libs,
    FONTCONFIG_PATH: join(deps, "etc/fonts"),
    XDG_DATA_HOME: join(deps, "usr/share"),
  };
}

const executablePath = resolveExecutable();
let browser;
try {
  browser = await chromium.launch({
    executablePath,
    // CHROME_ARGS: extra flags, one per "|" (flags can contain spaces). E.g. to drive the
    // deployed site through the gateway on this host, where *.logikos.dev has no DNS and
    // the certificate is self-signed:
    //   CHROME_ARGS="--host-resolver-rules=MAP dsp.logikos.dev 127.0.0.1|--ignore-certificate-errors"
    args: ["--no-sandbox", "--disable-gpu", ...(process.env.CHROME_ARGS ? process.env.CHROME_ARGS.split("|") : [])],
    env: browserEnv(),
    headless: true,
  });
} catch (err) {
  console.error(`err launch: ${err.message.split("\n")[0]}`);
  console.error(
    executablePath
      ? `(tried executablePath=${executablePath} — unset CHROME_PATH to use Playwright's own browser)`
      : "(no system Chrome found and no Playwright browser installed — see SKILL.md Prerequisites)",
  );
  process.exit(1);
}
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
    } else if (cmd === "viewport") {
      const [width, height] = arg.split("x").map(Number);
      await page.setViewportSize({ width, height });
      console.log(`ok viewport ${width}x${height}`);
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
