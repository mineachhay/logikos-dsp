# Source from the repo root with the stack up:  source .claude/skills/run-logikos-dsp/fake-share.sh
#
# Fakes a Windows file server + share held by a second, fake agent, so the audit-log paths
# (reads, cross-source COPIED, BULK_FILE_READ) can be driven without Windows/WinRM/SMB.
# Sets B, FSNAME, FSID, SHID, SECRET and defines post_reads <user> <path>... .
# Undo: curl -s -b /tmp/cookies.txt -X DELETE "$B/file-servers/$FSID?confirm=$FSNAME"
B=http://localhost:4000
TOK=$(grep ^AGENT_ENROLL_TOKEN packages/backend/.env | cut -d= -f2- | tr -d '"')
curl -s -c /tmp/cookies.txt -X POST $B/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.com","password":"DevAdmin123!"}' >/dev/null
# A fake second agent that "holds" a share. Its own key, so the real agent's secret isn't rotated.
REG=$(curl -s -X POST $B/agents/register -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' \
  -d '{"key":"fake-share-agent-0001","hostname":"fake-share-agent","watchedRoot":"smb://fs01/finance","capabilities":["managed-sources","windows-activity"]}')
AID=$(echo "$REG" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
SECRET=$(echo "$REG" | python3 -c 'import json,sys; print(json.load(sys.stdin)["agentSecret"])')
FSNAME=fs01-$(date +%s)
FSID=$(curl -s -b /tmp/cookies.txt -X POST $B/file-servers -H 'Content-Type: application/json' \
  -d '{"name":"'$FSNAME'","host":"fs01.example.test","username":"svc","password":"x","recordReads":true}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
SHID=$(curl -s -b /tmp/cookies.txt -X POST $B/file-servers/$FSID/shares -H 'Content-Type: application/json' \
  -d '{"shareName":"finance","agentId":"'$AID'"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
echo "FSNAME=$FSNAME FSID=$FSID SHID=$SHID"
# post_reads <user> <path>... : one Windows 5145 READ record per path, posted as the share's agent
post_reads() {
  python3 - "$FSID" "$SHID" "$@" <<'EOF' | curl -s -X POST $B/ingest/activity -H "Authorization: Bearer $SECRET" -H 'Content-Type: application/json' -d @-; echo
import json,sys,time,datetime
fs,sh,user,*paths=sys.argv[1:]
now=datetime.datetime.now(datetime.timezone.utc).isoformat()
print(json.dumps({"agentKey":"fake-share-agent-0001","fileServerId":fs,"bookmark":1,"records":[
  {"sourceId":sh,"path":p,"action":"READ","userName":user,"clientIp":"10.0.0.7","occurredAt":now,"recordId":time.time_ns()//1000+i}
  for i,p in enumerate(paths)]}))
EOF
}
