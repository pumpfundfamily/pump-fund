#!/usr/bin/env bash
# Adds pumpfund.family to the shared box's Caddy WITHOUT touching any other site:
#   - appends one block (never edits existing ones), after a timestamped backup
#   - `caddy validate` before `systemctl reload caddy` (⛔ never `caddy stop`: it stops the systemd
#     instance and takes every site down — memory caddy-stop-kills-the-live-server)
#   - records every other hostname's HTTP status before and after, and fails loudly on any change
set -euo pipefail
# the server is set in deploy/local.env (gitignored: VPS=user@host), or in the environment
LOCAL_ENV="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/local.env"
[[ -f "$LOCAL_ENV" ]] && . "$LOCAL_ENV"
VPS="${VPS:?set VPS=user@host in deploy/local.env}"
DOMAIN="${DOMAIN:-pumpfund.family}"
STAMP=$(date +%Y%m%d-%H%M%S)

if ssh "$VPS" "grep -qE '^(www\.)?$DOMAIN' /etc/caddy/Caddyfile"; then echo "$DOMAIN already in the Caddyfile, nothing to do"; exit 0; fi

snapshot() {
  ssh "$VPS" "grep -oE '^[a-z0-9.-]+\.[a-z]+' /etc/caddy/Caddyfile | sort -u" | grep -v "$DOMAIN" | while read -r h; do
    printf '%s %s\n' "$h" "$(curl -s -o /dev/null -m 10 -w '%{http_code}' "https://$h/" || echo ERR)"
  done
}
echo "==> snapshot of the other sites"
snapshot > "/tmp/pumpfund-caddy-before-$STAMP.txt"; wc -l < "/tmp/pumpfund-caddy-before-$STAMP.txt"

ssh "$VPS" "cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak-pumpfund-$STAMP && mkdir -p /root/pumpfund-web/dist"
echo "==> backup /etc/caddy/Caddyfile.bak-pumpfund-$STAMP"
ssh "$VPS" "cat >> /etc/caddy/Caddyfile" <<BLOCK

www.$DOMAIN {
	# One origin: OAuth callbacks and the session cookie are for the apex only.
	redir https://$DOMAIN{uri} permanent
}

$DOMAIN {
	encode zstd gzip

	handle /api/* {
		reverse_proxy 127.0.0.1:5590
	}
	handle {
		root * /root/pumpfund-web/dist
		try_files {path} /index.html
		file_server
		@assets path /assets/*
		header @assets Cache-Control "public, max-age=31536000, immutable"
		@entry path / /index.html
		header @entry Cache-Control "no-cache"
	}

	header {
		-Server
		X-Content-Type-Options nosniff
		X-Frame-Options SAMEORIGIN
		Referrer-Policy strict-origin-when-cross-origin
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
	}
}
BLOCK
if ! ssh "$VPS" "caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile" >/dev/null 2>&1; then
  echo "!! validation failed — restoring the backup, nothing was reloaded"
  ssh "$VPS" "cp /etc/caddy/Caddyfile.bak-pumpfund-$STAMP /etc/caddy/Caddyfile"
  exit 1
fi
ssh "$VPS" "systemctl reload caddy"
sleep 5
echo "==> snapshot after"
snapshot > "/tmp/pumpfund-caddy-after-$STAMP.txt"
if diff "/tmp/pumpfund-caddy-before-$STAMP.txt" "/tmp/pumpfund-caddy-after-$STAMP.txt"; then echo "==> every other site answers exactly as before"
else echo "!! another site changed status — see the diff above"; exit 1; fi
