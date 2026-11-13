#!/usr/bin/env bash
# Ships Pump Fund to the box: web (static) + api (node) + grinder. Touches only /root/pumpfund-*, /var/lib/pumpfund
# and the pumpfund-* systemd units.
set -euo pipefail
cd "$(dirname "$0")/.."
# the server is set in deploy/local.env (gitignored: VPS=user@host), or in the environment
LOCAL_ENV="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/local.env"
[[ -f "$LOCAL_ENV" ]] && . "$LOCAL_ENV"
VPS="${VPS:?set VPS=user@host in deploy/local.env}"
echo "==> build web"
(cd web && npm run build >/dev/null)
echo "==> grinder (static linux binary)"
(cd tools/grind && CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER=rust-lld cargo build --release --target x86_64-unknown-linux-musl >/dev/null 2>&1)
ssh "$VPS" "mkdir -p /root/pumpfund-web/dist /root/pumpfund-api/bin /var/lib/pumpfund /root/pumpfund-ops && chmod 700 /root/pumpfund-ops /var/lib/pumpfund"
# ⛔ --chmod: a deploy from a shell with umask 077 once left files 600 and Caddy served 403 to everyone.
rsync -a --delete --chmod=D755,F644 --no-owner --no-group web/dist/ "$VPS:/root/pumpfund-web/dist/"
# ⛔ A keeper pass that starts while npm ci rewrites node_modules dies on a missing package (seen 12 Nov 01:45): pause the
#    timer for the deploy (a pass already running finishes first), resume it at the end, also on failure.
#    ⛔ Resumed ONLY if it was running before: a deploy never switches the keeper on by itself (the operator enables it
#    once the keeper wallet is funded: systemctl enable --now pumpfund-keeper.timer).
KEEPER_WAS=$(ssh "$VPS" "systemctl is-active pumpfund-keeper.timer 2>/dev/null || true")
ssh "$VPS" "systemctl stop pumpfund-keeper.timer 2>/dev/null; while systemctl is-active --quiet pumpfund-keeper.service; do sleep 1; done" || true
trap '[[ "$KEEPER_WAS" == active ]] && ssh "$VPS" "systemctl start pumpfund-keeper.timer" || true' EXIT
rsync -a --delete --no-owner --no-group --exclude node_modules --exclude data --exclude test \
  api lib scripts package.json package-lock.json "$VPS:/root/pumpfund-api/"
rsync -a --chmod=F755 tools/grind/target/x86_64-unknown-linux-musl/release/pumpfund-grind "$VPS:/root/pumpfund-api/bin/pumpfund-grind"
rsync -a deploy/pumpfund-api.service deploy/pumpfund-keeper.service deploy/pumpfund-keeper.timer "$VPS:/etc/systemd/system/"
ssh "$VPS" "cd /root/pumpfund-api && npm ci --omit=dev --silent && systemctl daemon-reload"
if ssh "$VPS" "test -f /root/pumpfund-ops/api.env"; then
  # ⛔ restart, not `enable --now`: enable on a running unit leaves the OLD code running.
  ssh "$VPS" "systemctl enable pumpfund-api >/dev/null 2>&1; systemctl restart pumpfund-api"
  # The api takes ~4 s to start: poll up to 30 s instead of one early look.
  for i in $(seq 1 30); do
    code=$(curl -s -o /dev/null -w '%{http_code}' https://pumpfund.family/api/health || true)
    [[ "$code" == 200 ]] && break; sleep 1
  done
  [[ "$code" == 200 ]] || { echo "!! api health $code"; exit 1; }
else
  echo "   (no /root/pumpfund-ops/api.env yet: api not started)"
fi
for p in / /docs /explore; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "https://pumpfund.family$p" || true)
  [[ "$code" == 200 ]] || { echo "!! https://pumpfund.family$p answered $code"; exit 1; }
done
echo "==> deployed, site answers 200"
