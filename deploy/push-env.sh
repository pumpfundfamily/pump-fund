#!/usr/bin/env bash
# Builds the box's api.env from keys/mainnet/secrets.env + the keys and ships it to /root/pumpfund-ops
# (0700 dir, 0600 files). Values never appear on a command line or in a log.
set -euo pipefail
cd "$(dirname "$0")/.."
# the server is set in deploy/local.env (gitignored: VPS=user@host), or in the environment
LOCAL_ENV="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/local.env"
[[ -f "$LOCAL_ENV" ]] && . "$LOCAL_ENV"
VPS="${VPS:?set VPS=user@host in deploy/local.env}"
get() { grep -E "^$1=" keys/mainnet/secrets.env | cut -d= -f2- | sed -e 's/^["'"'"']//' -e 's/["'"'"']$//' || true; }
for f in keys/mainnet/launcher.json keys/mainnet/keeper.json keys/mainnet/fee-seed.hex keys/mainnet/secrets.env; do [[ -f $f ]] || { echo "missing $f (deploy/setup-keys.sh, then fill secrets.env)"; exit 1; }; done
tmp=$(mktemp); chmod 600 "$tmp"
cat > "$tmp" <<ENV
PUBLIC_URL=https://pumpfund.family
RPC_URL=$(get RPC_URL)
FEE_SEED=$(cat keys/mainnet/fee-seed.hex)
LAUNCH_KEY=/root/pumpfund-ops/launcher.json
KEEPER_KEY=/root/pumpfund-ops/keeper.json
$([[ -f keys/mainnet/platform-launcher.json ]] && echo PLATFORM_LAUNCH_KEY=/root/pumpfund-ops/platform-launcher.json)
X_HANDLE=$(get X_HANDLE)
PLATFORM_X_ID=$(get PLATFORM_X_ID)
PROJECT_TICKER=$(get PROJECT_TICKER)
PROJECT_NAME=$(get PROJECT_NAME)
X_CLIENT_ID=$(get X_CLIENT_ID)
X_CLIENT_SECRET=$(get X_CLIENT_SECRET)
TWITTERAPI_IO_KEY=$(get TWITTERAPI_IO_KEY)
FOMO_LOOKUP=$(get FOMO_LOOKUP)
XMONEY_ENABLED=$(get XMONEY_ENABLED)
BASE_RPC_URL=$(get BASE_RPC_URL)
PINATA_JWT=$(get PINATA_JWT)
GITHUB_TOKEN=$(get GITHUB_TOKEN)
DONATION_MIN_LAMPORTS=$(get DONATION_MIN_LAMPORTS)
IPFS_GATEWAY=https://gateway.pinata.cloud/ipfs
BOT=$(get BOT)
XMONEY_MIN_LAMPORTS=$(get XMONEY_MIN_LAMPORTS)
VANITY_TARGET=$(get VANITY_TARGET)
ENV
# drop empty lines (an empty VANITY_TARGET= would read as 0)
sed -i '' -E '/^[A-Z_]+=$/d' "$tmp"
ssh "$VPS" "mkdir -p /root/pumpfund-ops && chmod 700 /root/pumpfund-ops"
scp -q "$tmp" "$VPS:/root/pumpfund-ops/api.env"
scp -q keys/mainnet/launcher.json keys/mainnet/keeper.json "$VPS:/root/pumpfund-ops/"
# the project token's own launch + creator wallet (optional until go-live). ⛔ It must be the address the operator named in
# secrets.env (PLATFORM_WALLET): a wrong key file here would make some other wallet the creator of $FUND, for ever.
if [[ -f keys/mainnet/platform-launcher.json ]]; then
  want=$(get PLATFORM_WALLET)
  [[ -n $want ]] || { echo "keys/mainnet/platform-launcher.json exists but PLATFORM_WALLET is not set in secrets.env"; rm -f "$tmp"; exit 1; }
  pk=$(node -e "const{Keypair}=require('@solana/web3.js');const{readFileSync}=require('fs');console.log(Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync('keys/mainnet/platform-launcher.json')))).publicKey.toBase58())")
  [[ $pk == "$want" ]] || { echo "platform-launcher.json is $pk, not PLATFORM_WALLET $want"; rm -f "$tmp"; exit 1; }
  scp -q keys/mainnet/platform-launcher.json "$VPS:/root/pumpfund-ops/"
  echo "platform launcher: $pk"
fi
ssh "$VPS" "chmod 600 /root/pumpfund-ops/*"
rm -f "$tmp"
echo "env + keys on the box: $(ssh "$VPS" 'ls /root/pumpfund-ops | tr "\n" " "')"
