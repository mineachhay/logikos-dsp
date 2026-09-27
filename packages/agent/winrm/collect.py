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
import re
import sys

# EventRecordID > after, bounded above so a backlog can't be skipped: a fixed
# window is asked for each poll, and the caller advances the bookmark using
# newestRecordId when the window turns out to be empty.
# wevtutil, not Get-WinEvent: Get-WinEvent asks the Security log for its
# metadata before reading anything, and that step is refused to anyone without
# "Manage auditing and security log" — so it fails for an account that is in
# Event Log Readers and can read the events perfectly well ("Attempted to
# perform an unauthorized operation", seen against a real server once the
# share moved to a read-only service account). wevtutil queries events
# directly and works with just that group.
#
# EventRecordID > after, bounded above so a backlog can't be skipped: a fixed
# window is asked for each poll, and the caller advances the bookmark using
# newestRecordId when the window turns out to be empty.
SCRIPT = r"""
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
$newest = (wevtutil qe Security /c:1 /rd:true /f:XML 2>$null) -join ''
if ("$newest" -match '<EventRecordID>(\d+)</EventRecordID>') {{ Write-Output "NEWEST:$($Matches[1])" }}
else {{ Write-Output "ERR:could not read the Security log (wevtutil returned nothing)" }}
# The log is circular; record numbers below its oldest event are gone.
$oldest = (wevtutil qe Security /c:1 /f:XML 2>$null) -join ''
if ("$oldest" -match '<EventRecordID>(\d+)</EventRecordID>') {{ Write-Output "OLDEST:$($Matches[1])" }}
$q = "*[System[(EventID=5145) and (EventRecordID>{after}) and (EventRecordID<={until})]]{exclude}"
# One blob, split on </Event> by the caller: wevtutil wraps each event over
# several lines, so emitting a separator per line handed the parser fragments
# and every event was silently dropped.
$events = (wevtutil qe Security /q:$q /f:XML /c:{max_events} 2>$null) -join ''
# A rejected query must not look like an empty window: that would advance the
# bookmark past events never read. Reported as an error, the bookmark stays.
if ($LASTEXITCODE -ne 0) {{ Write-Output "ERR:wevtutil query failed (exit $LASTEXITCODE)" }}
Write-Output $events
"""


def exclude_clause(user: str) -> str:
    """XPath that drops the scan account's own 5145s on the server.

    Every file the share scan opens is a 5145 by that account — tens of
    thousands per walk — and they filled each capped result before a real
    user's change could appear. The event log's XPath compares strings
    case-sensitively and has no lower-case(), so the usual spellings are
    excluded; anything that slips through is still dropped by the agent
    (activityRecords.ts). Only plain account names are put into the query.
    """
    name = (user or "").split("\\")[-1].split("@")[0].strip()
    if not name or not re.fullmatch(r"[A-Za-z0-9._ -]{1,64}", name):
        return ""
    spellings = sorted({name, name.lower(), name.upper(), name[:1].upper() + name[1:].lower()})
    conditions = " and ".join(f"Data[@Name='SubjectUserName']!='{s}'" for s in spellings)
    return f" and *[EventData[{conditions}]]"


def main() -> int:
    cfg = json.load(sys.stdin)
    after = int(cfg.get("after") or 0)
    window = int(cfg.get("window") or 500)
    max_events = int(cfg.get("maxEvents") or window)
    result = {"events": [], "newestRecordId": None, "oldestRecordId": None, "windowEnd": after + window, "error": None}
    try:
        from pypsrp.client import Client

        # PowerShell Remoting (PSRP), not the plain WinRM shell: running a
        # command through the WinRM shell needs Execute on the service's SDDL,
        # which only administrators have by default — a read-only service
        # account in Remote Management Users gets "Access is denied" there,
        # while the PowerShell endpoint accepts exactly that group. Seen the
        # moment the share was switched to a service account.
        script = SCRIPT.format(
            after=after, until=after + window, max_events=max_events, exclude=exclude_clause(cfg.get("excludeUser") or "")
        )
        with Client(
            cfg["host"],
            port=int(cfg.get("port", 5985)),
            username=cfg["username"],
            password=cfg["password"],
            ssl=False,
            auth="ntlm",
            operation_timeout=int(cfg.get("operationTimeoutSec", 50)),
            read_timeout=int(cfg.get("readTimeoutSec", 60)),
        ) as client:
            raw_out, streams, had_errors = client.execute_ps(script)
        stdout = raw_out if isinstance(raw_out, str) else raw_out.decode("utf-8", "replace")
        stderr = " ".join(str(e) for e in streams.error)[:500]
        if had_errors and "NEWEST:" not in stdout and "<Event" not in stdout:
            result["error"] = stderr or "PowerShell reported an error with no output"
            return emit(result)
        for line in stdout.splitlines():
            if line.startswith("NEWEST:"):
                value = line[len("NEWEST:"):].strip()
                result["newestRecordId"] = int(value) if value.isdigit() else None
            elif line.startswith("OLDEST:"):
                value = line[len("OLDEST:"):].strip()
                result["oldestRecordId"] = int(value) if value.isdigit() else None
            elif line.startswith("ERR:"):
                result["error"] = line[len("ERR:"):].strip()
        body = stdout.split("NEWEST:", 1)[-1]
        result["events"] = [f"{chunk}</Event>" for chunk in body.split("</Event>") if "<Event" in chunk]
    except Exception as err:  # noqa: BLE001 — every failure is reported, never raised
        result["error"] = f"{type(err).__name__}: {err}"
    return emit(result)


def clean_stderr(text: str) -> str:
    """Drops PowerShell's CLIXML progress chatter, keeping any real message."""
    if "#< CLIXML" not in text:
        return text.strip()
    messages = re.findall(r"<S S=\"Error\">(.*?)</S>", text)
    return " ".join(m.replace("_x000D__x000A_", " ").strip() for m in messages).strip()


def emit(result: dict) -> int:
    json.dump(result, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
