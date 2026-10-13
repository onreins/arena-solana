#!/usr/bin/env bash
# Deploy the Reins programs to Solana DEVNET (never mainnet).
#
#   scripts/solana-devnet-deploy.sh
#
# Needs: the Solana CLI (2.3+), Anchor 0.31.1, and a funded devnet wallet at
# ~/.config/solana/id.json (solana airdrop 5 --url devnet). Program ids come
# from target/deploy/*-keypair.json; on a fresh machine without those files,
# `anchor keys sync` writes new ids into the code first (then rebuild, and
# update solana/arena.js, solana/follow.js and crates/arena-score to match).
# Keypairs are secrets: they're gitignored, and this script never prints them.
set -euo pipefail
cd "$(dirname "$0")/.."

URL=https://api.devnet.solana.com
[ "$(solana config get json_rpc_url | awk '{print $NF}')" = "$URL" ] || solana config set --url "$URL" >/dev/null
case "$(solana genesis-hash)" in
  EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG) ;; # devnet
  *) echo "Refusing: this isn't devnet." >&2; exit 1 ;;
esac

for k in arena follow score_gate; do
  [ -f "target/deploy/$k-keypair.json" ] || { echo "target/deploy/$k-keypair.json is missing: run anchor keys sync, then rebuild" >&2; exit 1; }
done

anchor build
echo "wallet $(solana address), balance $(solana balance)"
for k in arena follow score_gate; do
  # --use-rpc: send through RPC; the default TPU path needs direct websocket access, which a proxied network lacks
  solana program deploy "target/deploy/$k.so" --program-id "target/deploy/$k-keypair.json" --url "$URL" --use-rpc
  echo "$k: $(solana address -k target/deploy/$k-keypair.json)  https://explorer.solana.com/address/$(solana address -k target/deploy/$k-keypair.json)?cluster=devnet"
done
