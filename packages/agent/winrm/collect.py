#!/usr/bin/env python3
"""Reads new Windows Security events (5145) over WinRM.

Node drives this (packages/agent/src/activityCollector.ts): config as JSON on
stdin, result as JSON on stdout, never a non-zero exit for a remote failure —
the caller stores the message as the file server's collection error.

Python because WinRM's NTLM handshake and message encryption have no
maintained Node client; pywinrm (Debian's python3-winrm, the library Ansible
uses) does. Parsing stays in TypeScript, where it's unit-tested.
"""
import json
import sys

EVENT_SEPARATOR = "<<<EVT>>>"

# EventRecordID > after, bounded above so a backlog can't be skipped: a fixed
# window is asked for each poll, and the caller advances the bookmark using
# newestRecordId when the window turns out to be empty.
SCRIPT = """
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$newest = (Get-WinEvent -LogName Security -MaxEvents 1).RecordId
$filter = "*[System[(EventID=5145) and (EventRecordID>{after}) and (EventRecordID<={until})]]"
$events = Get-WinEvent -LogName Security -FilterXPath $filter -MaxEvents {max_events}
Write-Output "NEWEST:$newest"
foreach ($e in $events) {{ Write-Output ($e.ToXml() + "`n{sep}") }}
"""


def main() -> int:
    cfg = json.load(sys.stdin)
    after = int(cfg.get("after") or 0)
    window = int(cfg.get("window") or 500)
    result = {"events": [], "newestRecordId": None, "windowEnd": after + window, "error": None}
    try:
        import winrm  # provided by python3-winrm

        session = winrm.Session(
            f"http://{cfg['host']}:{cfg.get('port', 5985)}/wsman",
            auth=(cfg["username"], cfg["password"]),
            transport="ntlm",
            read_timeout_sec=int(cfg.get("readTimeoutSec", 60)),
            operation_timeout_sec=int(cfg.get("operationTimeoutSec", 50)),
        )
        script = SCRIPT.format(after=after, until=after + window, max_events=window, sep=EVENT_SEPARATOR)
        response = session.run_ps(script)
        stdout = response.std_out.decode("utf-8", "replace")
        stderr = response.std_err.decode("utf-8", "replace").strip()
        if response.status_code != 0:
            result["error"] = stderr or f"PowerShell exited {response.status_code}"
            return emit(result)
        for line in stdout.splitlines():
            if line.startswith("NEWEST:"):
                value = line[len("NEWEST:"):].strip()
                result["newestRecordId"] = int(value) if value.isdigit() else None
        body = stdout.split("NEWEST:", 1)[-1]
        result["events"] = [chunk.strip() for chunk in body.split(EVENT_SEPARATOR) if "<Event" in chunk]
    except Exception as err:  # noqa: BLE001 — every failure is reported, never raised
        result["error"] = f"{type(err).__name__}: {err}"
    return emit(result)


def emit(result: dict) -> int:
    json.dump(result, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
