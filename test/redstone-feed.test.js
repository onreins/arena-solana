/**
 * RedStonePriceFeed: a Chainlink-shaped feed kept current by RedStone's signed
 * prices. It must store a price only when enough authorised signers agree and
 * the package is recent, never go backwards, and look to a Mandate exactly
 * like the Chainlink feeds it already reads.
 *
 * RedStoneTestFeed is the same contract trusting five throwaway test signers,
 * so packages here are signed locally instead of fetched from RedStone.
 */
import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { decodeErrorResult, encodeFunctionData, stringToHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { DataPackage, NumericDataPoint, RedstonePayload } from "@redstone-finance/protocol";

import { publicClient, walletFor, waitForNode, localChain, expectRevert } from "./helpers.js";
import { artifact } from "../scripts/artifact.js";
import { pushPrice, redstoneFeedId, updateCalldata } from "../mandate/redstone.js";

const deployer = walletFor(0);
const stranger = walletFor(4);
const FEED = artifact("RedStoneTestFeed");
const PINNED = artifact("PinnedFeed");
const signerKeys = Array.from({ length: 5 }, () => generatePrivateKey());
const outsiderKeys = Array.from({ length: 3 }, () => generatePrivateKey());

let feed;

async function deploy(art, args) {
  const hash = await deployer.deployContract({ abi: art.abi, bytecode: art.bytecode, args, account: deployer.account, chain: localChain });
  return (await publicClient.waitForTransactionReceipt({ hash })).contractAddress;
}

const chainNowMs = async () => Number((await publicClient.getBlock()).timestamp) * 1000;

/** A payload of EUROC packages at `value`, signed by `keys`, timestamped `ms`. */
function payload(keys, value, ms) {
  const packages = keys.map((key) =>
    new DataPackage([new NumericDataPoint({ dataFeedId: "EUROC", value, decimals: 8 })], ms, "EUROC").sign(key),
  );
  return new RedstonePayload(packages, "").toBytesHexWithout0xPrefix();
}

async function push(wallet, hex) {
  const hash = await wallet.sendTransaction({ to: feed, data: updateCalldata(hex), account: wallet.account, chain: localChain });
  return publicClient.waitForTransactionReceipt({ hash });
}

/**
 * The same call as a simulation. The node reports a custom error only as raw
 * data, so decode it against the feed's ABI and rethrow it by name.
 */
async function simulate(hex) {
  try {
    return await publicClient.call({ to: feed, data: updateCalldata(hex), account: stranger.account.address });
  } catch (err) {
    const hit = err.walk?.((e) => typeof e?.data?.data === "string" || (typeof e?.data === "string" && e.data.startsWith("0x")));
    const raw = typeof hit?.data === "string" ? hit.data : hit?.data?.data;
    if (!raw || raw === "0x") throw err;
    throw new Error(decodeErrorResult({ abi: FEED.abi, data: raw }).errorName);
  }
}

const latest = () => publicClient.readContract({ address: feed, abi: FEED.abi, functionName: "latestRoundData" });

before(async () => {
  await waitForNode();
  feed = await deploy(FEED, [stringToHex("EUROC", { size: 32 }), signerKeys.map((k) => privateKeyToAccount(k).address)]);
});

describe("the shape a Mandate expects", () => {
  test("8 decimals, a description, and no price until the first push", async () => {
    const read = (functionName) => publicClient.readContract({ address: feed, abi: FEED.abi, functionName });
    assert.equal(await read("decimals"), 8);
    assert.equal(await read("description"), "test feed");
    const [round, answer, , updatedAt] = await latest();
    assert.equal(round, 0n);
    assert.equal(answer, 0n);
    assert.equal(updatedAt, 0n);
  });
});

describe("pushing a signed price", () => {
  test("3 of 5 signers agreeing store the price, from anyone", async () => {
    const ms = await chainNowMs();
    const receipt = await push(stranger, payload(signerKeys.slice(0, 3), 1.1189, ms));
    assert.equal(receipt.status, "success");
    const [round, answer, , updatedAt] = await latest();
    assert.equal(round, 1n);
    assert.equal(answer, 111_890_000n);
    assert.equal(updatedAt, BigInt(Math.floor(ms / 1000)));
  });

  test("the median of the signers' values is what's stored", async () => {
    const ms = (await chainNowMs()) + 1000;
    const keys = signerKeys.slice(0, 3);
    const packages = [1.10, 1.12, 1.30].map((value, i) =>
      new DataPackage([new NumericDataPoint({ dataFeedId: "EUROC", value, decimals: 8 })], ms, "EUROC").sign(keys[i]),
    );
    await push(stranger, new RedstonePayload(packages, "").toBytesHexWithout0xPrefix());
    const [, answer] = await latest();
    assert.equal(answer, 112_000_000n);
  });

  test("two signers are not enough", async () => {
    await expectRevert(simulate(payload(signerKeys.slice(0, 2), 1.2, await chainNowMs())), "InsufficientNumberOfUniqueSigners");
  });

  test("a package signed by keys it doesn't trust is refused", async () => {
    await expectRevert(simulate(payload(outsiderKeys, 1.2, await chainNowMs())), "SignerNotAuthorised");
  });

  test("a package more than 60 seconds old is refused", async () => {
    await expectRevert(simulate(payload(signerKeys.slice(0, 3), 1.2, (await chainNowMs()) - 90_000)), "PackageTooOld");
  });

  test("a package from more than 10 seconds ahead is refused", async () => {
    await expectRevert(simulate(payload(signerKeys.slice(0, 3), 1.2, (await chainNowMs()) + 60_000)), "PackageFromFuture");
  });

  test("a zero price is refused, never stored", async () => {
    await expectRevert(simulate(payload(signerKeys.slice(0, 3), 0, (await chainNowMs()) + 2000)), "BadAnswer");
  });

  test("an older package than the one stored changes nothing and doesn't fail", async () => {
    const [roundBefore, answerBefore, , updatedBefore] = await latest();
    const receipt = await push(stranger, payload(signerKeys.slice(0, 3), 9.99, Number(updatedBefore) * 1000 - 20_000));
    assert.equal(receipt.status, "success");
    const [round, answer, , updatedAt] = await latest();
    assert.equal(round, roundBefore);
    assert.equal(answer, answerBefore);
    assert.equal(updatedAt, updatedBefore);
  });
});

describe("the SDK helper", () => {
  test("knows a RedStone feed by its data feed id, and leaves other feeds alone", async () => {
    assert.equal(await redstoneFeedId(publicClient, feed), "EUROC");
    const pinned = await deploy(PINNED, [8, "EURC / USD (pinned)", 113_790_000n]);
    assert.equal(await redstoneFeedId(publicClient, pinned), null);
    assert.equal(await pushPrice({ publicClient, wallet: stranger, feed: pinned }), null);
  });

  test("a busy RPC is reported, never remembered as 'not a RedStone feed'", async () => {
    const fresh = await deploy(FEED, [stringToHex("EUROC", { size: 32 }), signerKeys.map((k) => privateKeyToAccount(k).address)]);
    let calls = 0;
    const flaky = {
      readContract: async (args) => {
        calls += 1;
        if (calls === 1) throw new Error("Request exceeds defined limit.");
        return publicClient.readContract(args);
      },
    };
    await assert.rejects(redstoneFeedId(flaky, fresh), /exceeds defined limit/);
    assert.equal(await redstoneFeedId(flaky, fresh), "EUROC");
  });

  test("pushPrice fetches a signed package and stores it", async () => {
    const ms = (await chainNowMs()) + 5000;
    const request = async (params) => {
      assert.deepEqual(params.dataPackagesIds, ["EUROC"]);
      assert.equal(params.uniqueSignersCount, 3);
      return payload(signerKeys.slice(1, 4), 1.1234, ms);
    };
    const hash = await pushPrice({ publicClient, wallet: stranger, feed, request });
    assert.match(hash, /^0x[0-9a-f]{64}$/);
    const [, answer] = await latest();
    assert.equal(answer, 112_340_000n);
  });
});

describe("FreshCheckpoint: push a price and run the stop-loss in one transaction", () => {
  const HELPER = artifact("FreshCheckpoint");
  const PROBE = artifact("CheckpointProbe");
  let helper, probe;

  before(async () => {
    helper = await deploy(HELPER, []);
    probe = await deploy(PROBE, [feed, 100_000_000n]); // freezes below $1.00
  });

  const callData = (hex) =>
    encodeFunctionData({ abi: HELPER.abi, functionName: "refreshAndCheckpoint", args: [feed, probe] }) + hex;
  const frozen = () => publicClient.readContract({ address: probe, abi: PROBE.abi, functionName: "frozen" });

  test("above the floor it reverts as a whole: no freeze, and the pushed price isn't kept either", async () => {
    const [roundBefore] = await latest();
    const hex = payload(signerKeys.slice(0, 3), 1.05, (await chainNowMs()) + 6000);
    await assert.rejects(publicClient.call({ to: helper, data: callData(hex), account: stranger.account.address }));
    const [round] = await latest();
    assert.equal(round, roundBefore);
    assert.equal(await frozen(), false);
  });

  test("below the floor it stores the fresh price and freezes, in one transaction", async () => {
    const hex = payload(signerKeys.slice(0, 3), 0.9, (await chainNowMs()) + 7000);
    const hash = await stranger.sendTransaction({ to: helper, data: callData(hex), account: stranger.account, chain: localChain });
    assert.equal((await publicClient.waitForTransactionReceipt({ hash })).status, "success");
    const [, answer] = await latest();
    assert.equal(answer, 90_000_000n);
    assert.equal(await frozen(), true);
  });
});
