/**
 * Onboard a demo follower on DEVNET, the way the app's Copy flow does:
 *   1. dUSDT from Velocity's devnet faucet
 *   2. a Velocity account (subaccount 0) and a dedicated copy subaccount (1)
 *      with collateral deposited into it
 *   3. the copier set as that subaccount's delegate: it can trade, never withdraw
 *   4. a subscription to a house agent's plan (devnet test USDC), with a
 *      performance-fee allowance to the follower's own Follow account
 *
 *   node scripts/demo-follower.mjs <follower-keypair> <agent pubkey>
 *
 * Env: FOLLOW_CONFIG, COPIER_PUBKEY (the copier's Solana key), USDC_MINT and
 * USDC_AUTHORITY_KEYPAIR (the devnet test mint and its authority, to fund the
 * follower), SOLANA_RPC_URL. Devnet only. Only public keys are printed.
 */
import { readFileSync } from "node:fs";
import "../src/poll-confirm.js";
import sdk from "@velocity-exchange/sdk";
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";

import {
  configAddress, planAddress, followAddress, decodeFollowAccount, associatedTokenAddress, createAssociatedTokenAccountIx,
  subscribeIx, approveIx, TOKEN_PROGRAM_ID, SIZE_FIXED,
} from "../../solana/follow.js";
import { sendAndConfirmByPolling } from "../../solana/arena.js";

const { VelocityClient, Wallet, BN, TokenFaucet, DevnetSpotMarkets, BulkAccountLoader } = sdk;
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const FAUCET_PROGRAM = new PublicKey("V4v1mQiAdLz4qwckEb45WqHYceYizoib39cDBHSWfaB");
const COPY_SUB = 1;
const tx = (sig) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
const key = (p) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));

const [followerFile, agentText] = process.argv.slice(2);
const env = process.env;
const connection = new Connection(env.SOLANA_RPC_URL || "https://api.devnet.solana.com", "confirmed");
if ((await connection.getGenesisHash()) !== DEVNET_GENESIS) throw new Error("Refusing: not devnet.");
const follower = key(followerFile);
const agent = new PublicKey(agentText);
const copier = new PublicKey(env.COPIER_PUBKEY);
console.log(`follower ${follower.publicKey.toBase58()}`);

// ---------------------------------------------------------------- Velocity
const dusdt = DevnetSpotMarkets.find((m) => m.symbol === "dUSDT");
const faucet = new TokenFaucet(connection, new Wallet(follower), FAUCET_PROGRAM, dusdt.mint);
const dusdtAta = associatedTokenAddress(follower.publicKey, dusdt.mint);
if (!(await connection.getAccountInfo(dusdtAta))) {
  const [, sig] = await faucet.createAssociatedTokenAccountAndMintTo(follower.publicKey, new BN(1_000 * 1e6));
  console.log(`1000 dUSDT from the faucet: ${tx(sig)}`);
}

const client = new VelocityClient({
  connection, wallet: new Wallet(follower), env: "devnet",
  accountSubscription: { type: "polling", accountLoader: new BulkAccountLoader(connection, "confirmed", 1_000) },
});
await client.subscribe();
const userPda = (sub) => sdk.getUserAccountPublicKeySync(client.program.programId, follower.publicKey, sub);
if (!(await connection.getAccountInfo(userPda(0)))) {
  const [sig] = await client.initializeUserAccount(0, "Main");
  console.log(`Velocity account (subaccount 0): ${tx(sig)}`);
}
if (!(await connection.getAccountInfo(userPda(COPY_SUB)))) {
  const [sig] = await client.initializeUserAccount(COPY_SUB, "Reins copy");
  console.log(`copy subaccount ${COPY_SUB}: ${tx(sig)}`);
}
await client.addUser(COPY_SUB, follower.publicKey);
await client.switchActiveUser(COPY_SUB, follower.publicKey);
const deposited = await client.deposit(new BN(500 * 1e6), dusdt.marketIndex, dusdtAta, COPY_SUB);
console.log(`500 dUSDT into the copy subaccount: ${tx(deposited)}`);
const delegated = await client.updateUserDelegate(copier, COPY_SUB);
console.log(`copier ${copier.toBase58()} is the copy subaccount's delegate (trade only, never withdraw): ${tx(delegated)}`);
await client.unsubscribe();

// ---------------------------------------------------------------- the subscription
const usdc = new PublicKey(env.USDC_MINT);
const config = new PublicKey(env.FOLLOW_CONFIG);
const cfg = decodeFollowAccount((await connection.getAccountInfo(config)).data);
const plan = planAddress(config, agent);
const planAccount = decodeFollowAccount((await connection.getAccountInfo(plan)).data);
const followerUsdc = associatedTokenAddress(follower.publicKey, usdc);
const authority = key(env.USDC_AUTHORITY_KEYPAIR);
const mintTo = (() => {
  const data = Buffer.alloc(9);
  data.writeUInt8(7, 0);
  data.writeBigUInt64LE(100_000_000n, 1); // 100 test USDC
  return new TransactionInstruction({ programId: TOKEN_PROGRAM_ID, data, keys: [
    { pubkey: usdc, isSigner: false, isWritable: true }, { pubkey: followerUsdc, isSigner: false, isWritable: true }, { pubkey: authority.publicKey, isSigner: true, isWritable: false },
  ] });
})();
await sendAndConfirmByPolling(connection, new Transaction().add(createAssociatedTokenAccountIx({ payer: authority.publicKey, owner: follower.publicKey, mint: usdc }), mintTo), [authority]);
const settings = { sizeMode: SIZE_FIXED, sizeValue: 50_000_000n, maxTrade: 100_000_000n, maxOpen: 3, dailyLossCap: 25_000_000n, subAccountId: COPY_SUB };
const subSig = await sendAndConfirmByPolling(connection, new Transaction().add(
  subscribeIx({ follower: follower.publicKey, config, agent, followerToken: followerUsdc, payout: planAccount.payout, treasury: cfg.treasury, months: 1, settings, maxPrice: planAccount.price, maxPerfFeeBps: planAccount.perfFeeBps }),
  approveIx({ account: followerUsdc, delegate: followAddress(plan, follower.publicKey), owner: follower.publicKey, amount: 20_000_000n }),
), [follower]);
console.log(`subscribed to ${agent.toBase58()} ($${Number(planAccount.price) / 1e6}/month, $50 per trade, max 3 open, $25 daily loss cap): ${tx(subSig)}`);
console.log(`  follow ${followAddress(plan, follower.publicKey).toBase58()} (config ${configAddress(cfg.admin).toBase58()})`);
process.exit(0);
