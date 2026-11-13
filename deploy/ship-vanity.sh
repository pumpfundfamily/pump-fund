#!/usr/bin/env bash
# Ships …fund mint keys ground on this machine (keys/mainnet/vanity-extra/*fund.json) into the box's grinder inbox,
# which the API imports into its pool within a few minutes (api/vanity.mjs importDir). A local copy is deleted only
# after the box confirms it holds that file. Prints counts only, never a key.
set -euo pipefail
cd "$(dirname "$0")/.."
# the server is set in deploy/local.env (gitignored: VPS=user@host), or in the environment
LOCAL_ENV="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/local.env"
[[ -f "$LOCAL_ENV" ]] && . "$LOCAL_ENV"
VPS="${VPS:?set VPS=user@host in deploy/local.env}"
SRC=keys/mainnet/vanity-extra
DEST=/var/lib/pumpfund/vanity-incoming
shopt -s nullglob
files=("$SRC"/*fund.json)
[[ ${#files[@]} -gt 0 ]] || { echo "no keys in $SRC"; exit 0; }
ssh "$VPS" "mkdir -p $DEST && chmod 700 $DEST"
scp -q "${files[@]}" "$VPS:$DEST/"
# scp exited 0 under set -e: every file is on the box (it may already be imported), so the local copies go
rm -f "${files[@]}"
sent=${#files[@]}
echo "shipped $sent keys; the pool picks them up within a few minutes"
