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
# PowerShell writes progress records ("Preparing modules for first use") to
# stderr as CLIXML; harmless, but it used to be read as a failed poll.
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
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
        import base64

        from winrm.protocol import Protocol  # provided by python3-winrm

        # Protocol, not Session.run_ps: run_ps pipes stderr through
        # _clean_error_msg, which calls str.startswith on bytes and raises
        # TypeError on Python 3 whenever PowerShell writes anything at all to
        # stderr — seen against a real server on the very first poll.
        protocol = Protocol(
            endpoint=f"http://{cfg['host']}:{cfg.get('port', 5985)}/wsman",
            transport="ntlm",
            username=cfg["username"],
            password=cfg["password"],
            read_timeout_sec=int(cfg.get("readTimeoutSec", 60)),
            operation_timeout_sec=int(cfg.get("operationTimeoutSec", 50)),
        )
        script = SCRIPT.format(after=after, until=after + window, max_events=window, sep=EVENT_SEPARATOR)
        encoded = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
        shell_id = protocol.open_shell(codepage=65001)
        try:
            command_id = protocol.run_command(shell_id, "powershell.exe", ["-NoProfile", "-EncodedCommand", encoded])
            try:
                raw_out, raw_err, status_code = protocol.get_command_output(shell_id, command_id)
            finally:
                protocol.cleanup_command(shell_id, command_id)
        finally:
            protocol.close_shell(shell_id)
        stdout = raw_out.decode("utf-8", "replace")
        stderr = clean_stderr(raw_err.decode("utf-8", "replace"))
        # Judge by what came back, not by the exit code or a chatty stderr:
        # PowerShell can return non-zero while still having answered.
        if "NEWEST:" not in stdout and "<Event" not in stdout:
            result["error"] = stderr or f"PowerShell exited {status_code} without output"
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
