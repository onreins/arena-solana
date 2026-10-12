/**
 * Cancel a follower's open orders on one market, as the copier (their copy
 * subaccount's delegate may place and cancel orders, never withdraw). For an
 * operator cleaning up, e.g. triggers left open by an entry that never filled.
 *
 *   COPIER_KEYPAIR=… node scripts/cancel-orders.mjs <follower> <subAccountId> <perpMarketIndex>
 */
import "../src/poll-confirm.js";
import sdk from "@velocity-exchange/sdk";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

import { readSecretFile } from "../src/server.js";

const { VelocityClient, Wallet, BulkAccountLoader, MarketType } = sdk;
const [followerText, subText, marketText] = process.argv.slice(2);
const copier = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readSecretFile(process.env.COPIER_KEYPAIR))));
const follower = new PublicKey(followerText);
const sub = Number(subText), market = Number(marketText);
const connection = new Connection(process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com", "confirmed");
const client = new VelocityClient({
  connection, wallet: new Wallet(copier), env: process.env.VELOCITY_ENV || "devnet",
  authoritySubAccountMap: new Map([[follower.toBase58(), [sub]]]),
  accountSubscription: { type: "polling", accountLoader: new BulkAccountLoader(connection, "confirmed", 1_000) },
});
await client.subscribe();
await client.switchActiveUser(sub, follower);
const sig = await client.cancelOrders(MarketType.PERP, market, undefined, undefined, sub);
console.log(`cancelled ${follower.toBase58()}'s orders on perp market ${market} (subaccount ${sub}): https://explorer.solana.com/tx/${sig}?cluster=devnet`);
process.exit(0);
