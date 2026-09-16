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

EVENT_SEPARATOR = "<<<EVT>>>"

# EventRecordID > after, bounded above so a backlog can't be skipped: a fixed
# window is asked for each poll, and the caller advances the bookmark using
# newestRecordId when the window turns out to be empty.
# Everything is wrapped so PowerShell never writes to stderr: "no events match"
# is a normal outcome here, not an error, and a stderr write used to be enough
# to break the client library.
SCRIPT = """
$ErrorActionPreference = 'SilentlyContinue'
# Progress records would otherwise be returned as an extra stream and read as
# a failed poll. No [Console]::OutputEncoding here: PowerShell Remoting has no
# console to set it on ("The handle is invalid"), and hands back text already.
$ProgressPreference = 'SilentlyContinue'
try {{
  $newest = (Get-WinEvent -LogName Security -MaxEvents 1 -ErrorAction Stop).RecordId
  Write-Output "NEWEST:$newest"
}} catch {{
  Write-Output "ERR:$($_.Exception.Message)"
}}
try {{
  $filter = "*[System[(EventID=5145) and (EventRecordID>{after}) and (EventRecordID<={until})]]"
  $events = Get-WinEvent -LogName Security -FilterXPath $filter -MaxEvents {max_events} -ErrorAction Stop
  foreach ($e in $events) {{ Write-Output ($e.ToXml() + "`n{sep}") }}
}} catch {{
  if ($_.Exception.Message -notmatch 'No events were found') {{ Write-Output "ERR:$($_.Exception.Message)" }}
}}
"""


def main() -> int:
    cfg = json.load(sys.stdin)
    after = int(cfg.get("after") or 0)
    window = int(cfg.get("window") or 500)
    result = {"events": [], "newestRecordId": None, "windowEnd": after + window, "error": None}
    try:
        from pypsrp.client import Client

        # PowerShell Remoting (PSRP), not the plain WinRM shell: running a
        # command through the WinRM shell needs Execute on the service's SDDL,
        # which only administrators have by default — a read-only service
        # account in Remote Management Users gets "Access is denied" there,
        # while the PowerShell endpoint accepts exactly that group. Seen the
        # moment the share was switched to a service account.
        script = SCRIPT.format(after=after, until=after + window, max_events=window, sep=EVENT_SEPARATOR)
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
            elif line.startswith("ERR:"):
                result["error"] = line[len("ERR:"):].strip()
        body = stdout.split("NEWEST:", 1)[-1]
        result["events"] = [chunk.strip() for chunk in body.split(EVENT_SEPARATOR) if "<Event" in chunk]
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
