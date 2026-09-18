#!/usr/bin/env python3
"""Installs the agent on a Windows machine over WinRM.

Node drives this (packages/agent/src/deployer.ts): config as JSON on stdin,
result as JSON on stdout, never a non-zero exit for a remote failure — the
caller reports the message as the deployment's outcome.

Same reasoning as collect.py for both the language and the protocol: WinRM's
NTLM handshake has no maintained Node client, and PSRP rather than the plain
WinRM shell because the shell needs Execute on the service's SDDL while the
PowerShell endpoint accepts Remote Management Users.

The binary is copied over PSRP rather than fetched by the target from a URL.
A workstation on a closed network may have no route to the dashboard at all,
and a download would need either an open endpoint or a token minted for it —
more moving parts than sending 7MB down a connection that is already open.
"""
import json
import os
import sys

# Installing, not merely running: the agent registers itself as a service that
# survives reboots. -ca cloudflare-origin uses the CA built into the binary,
# which is what lets it verify the origin certificate directly on the LAN.
INSTALL = r"""
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
& '{exe}' install {args} 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) {{ Write-Output "EXITCODE:$LASTEXITCODE" }}
"""


def quote(value: str) -> str:
    """Quotes an argument for PowerShell, doubling any embedded quotes."""
    return '"' + value.replace('"', '""') + '"'


def build_args(install: dict) -> str:
    args = ["-server", quote(install["serverUrl"]), "-token", quote(install["enrollToken"])]
    if install.get("watchPath"):
        args += ["-watch", quote(install["watchPath"])]
    if install.get("connectIp"):
        args += ["-ip", quote(install["connectIp"])]
    if install.get("allDrives"):
        args.append("-all-drives")
    if install.get("removable"):
        args.append("-removable")
    args += ["-ca", "cloudflare-origin"]
    return " ".join(args)


def main() -> int:
    cfg = json.load(sys.stdin)
    result = {"success": False, "message": ""}

    installer = cfg["installerPath"]
    if not os.path.exists(installer):
        result["message"] = (
            f"no agent build to deploy at {installer} — the server has no installer available"
        )
        return emit(result)

    # Windows\Temp rather than a user profile: the account installing may have
    # no profile on the target, and this path exists on every Windows machine.
    remote_path = r"C:\Windows\Temp\logikos-dsp-agent.exe"

    try:
        from pypsrp.client import Client

        with Client(
            cfg["address"],
            port=int(cfg.get("port", 5985)),
            username=cfg["username"],
            password=cfg["password"],
            ssl=False,
            auth="ntlm",
            operation_timeout=int(cfg.get("operationTimeoutSec", 120)),
            read_timeout=int(cfg.get("readTimeoutSec", 150)),
        ) as client:
            client.copy(installer, remote_path)
            script = INSTALL.format(exe=remote_path, args=build_args(cfg["install"]))
            raw_out, streams, had_errors = client.execute_ps(script)

        stdout = raw_out if isinstance(raw_out, str) else raw_out.decode("utf-8", "replace")
        errors = " ".join(str(e) for e in streams.error)[:1000]

        # The installer itself reports success in words, and refuses to install
        # when it can't register — so its own output is the truth here, not the
        # absence of a PowerShell error.
        if "installed and started" in stdout:
            result["success"] = True
            result["message"] = stdout.strip()[:1000]
        else:
            result["message"] = (stdout.strip() or errors or "the installer produced no output")[:1000]
            if had_errors and errors:
                result["message"] = f"{result['message']} :: {errors}"[:1000]
    except Exception as err:  # noqa: BLE001 — every failure is reported, never raised
        result["message"] = describe(err)

    return emit(result)


def describe(err: Exception) -> str:
    """Turns the usual failures into something an administrator can act on."""
    text = f"{type(err).__name__}: {err}"
    lowered = text.lower()
    if "unauthorized" in lowered or "401" in text:
        return f"{text} — check the username and password, and that the account is an administrator on that machine"
    if "connection" in lowered or "timed out" in lowered or "refused" in lowered:
        return (
            f"{text} — WinRM (port 5985) did not answer. It is off by default on Windows 10/11; "
            "enable it with 'winrm quickconfig' or a GPO, or install the agent by hand there"
        )
    if "md4" in lowered:
        return f"{text} — the agent container needs OpenSSL's legacy provider for NTLM"
    return text


def emit(result: dict) -> int:
    json.dump(result, sys.stdout)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
