#!/bin/sh
# Runs from the nginx image's /docker-entrypoint.d/ before nginx starts. If the
# cert dir lacks $PROXY_CERT_FILE/$PROXY_KEY_FILE, make a self-signed pair so the
# proxy can come up at all — unless PROXY_SELF_SIGNED=no, for a directory that
# is meant to hold a real certificate: there a stand-in would sit under the real
# file names and look like the real thing, so fail loudly instead (the image's
# entrypoint runs under set -e, so this stops the container).
set -eu
dir=/etc/nginx/certs
crt=$dir/${PROXY_CERT_FILE:-tls.crt}
key=$dir/${PROXY_KEY_FILE:-tls.key}
[ -s "$crt" ] && [ -s "$key" ] && exit 0

if [ "${PROXY_SELF_SIGNED:-yes}" = no ]; then
  echo "40-self-signed-cert.sh: $crt and/or $key missing or empty (PROXY_CERT_DIR on the host), and PROXY_SELF_SIGNED=no" >&2
  exit 1
fi

name=${PROXY_SERVER_NAME:-localhost}
case $name in
  *[!0-9.]*) san="DNS:$name" ;;   # a hostname
  *)         san="IP:$name" ;;    # an IPv4 address
esac
echo "40-self-signed-cert.sh: no certificate in $dir, generating a self-signed one for $name"
openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
  -keyout "$key" -out "$crt" \
  -subj "/CN=$name" -addext "subjectAltName=$san,DNS:localhost" 2>/dev/null
chmod 600 "$key"
