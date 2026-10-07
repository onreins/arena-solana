// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PrimaryProdDataServiceConsumerBase} from
    "@redstone-finance/evm-connector/contracts/data-services/PrimaryProdDataServiceConsumerBase.sol";

/**
 * A Chainlink-shaped price feed kept current by RedStone's signed prices.
 *
 * RedStone is a pull oracle: its signers publish prices off-chain every few
 * seconds, and whoever needs one on-chain brings a signed package in the
 * calldata of updatePrice(). This contract checks it the way RedStone's own
 * base contract does (signatures from at least 3 of the 5 authorised
 * "redstone-primary-prod" signers, the median of their values, and a package
 * no older than 3 minutes), then stores it.
 *
 * Mandates read it like any Chainlink feed (decimals, latestRoundData), so an
 * agent's trade is checked against a price seconds old: its trading path
 * pushes the latest package just before it trades. Anyone can push one; the
 * signatures are what's trusted, not the caller. Nobody owns this contract and
 * nothing in it can be changed after deployment.
 */
contract RedStonePriceFeed is PrimaryProdDataServiceConsumerBase {
    /// The RedStone data feed, e.g. "EUROC" (Circle's EURC under its first ticker).
    bytes32 public immutable dataFeedId;
    string public description;

    /// RedStone numeric values carry 8 decimals, like Chainlink's USD feeds.
    uint8 public constant decimals = 8;
    uint256 public constant version = 1;

    uint80 private _round;
    int256 private _answer;
    uint256 private _updatedAt;

    /// A pushed package may be at most this old. RedStone's default is 3
    /// minutes; a shorter window leaves the sender less room to pick, among
    /// the packages still valid, the one that suits it best.
    uint256 public constant MAX_PACKAGE_AGE = 60 seconds;
    /// ...and at most this far ahead of the block, for clocks that drift.
    uint256 public constant MAX_PACKAGE_AHEAD = 10 seconds;

    event PriceUpdated(uint80 indexed round, int256 answer, uint256 updatedAt);
    error BadAnswer(uint256 value);
    error PackageTooOld(uint256 packageTime, uint256 blockTime);
    error PackageFromFuture(uint256 packageTime, uint256 blockTime);

    constructor(bytes32 dataFeedId_, string memory description_) {
        dataFeedId = dataFeedId_;
        description = description_;
    }

    /**
     * Store the price carried in this call's RedStone payload. A package no
     * newer than the stored price changes nothing and doesn't revert, so two
     * pushes racing each other never fail the trade behind them.
     */
    function updatePrice() external returns (int256 answer, uint256 updatedAt) {
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = dataFeedId;
        (uint256[] memory values, uint256 timestampMs) = getOracleNumericValuesAndTimestampFromTxMsg(ids);
        // This getter returns the package time without checking it (unlike
        // getOracleNumericValuesFromTxMsg), so check it here: no older than 3
        // minutes, no more than 1 ahead. Without it an old package could be
        // replayed to set a stale price.
        validateTimestamp(timestampMs);
        if (values[0] == 0 || values[0] > uint256(type(int256).max)) revert BadAnswer(values[0]);
        uint256 at = timestampMs / 1000;
        if (at <= _updatedAt) return (_answer, _updatedAt);

        _round += 1;
        _answer = int256(values[0]);
        _updatedAt = at;
        emit PriceUpdated(_round, _answer, at);
        return (_answer, at);
    }

    /// RedStone's timestamp check, tightened to MAX_PACKAGE_AGE / MAX_PACKAGE_AHEAD.
    function validateTimestamp(uint256 receivedTimestampMilliseconds) public view virtual override {
        uint256 at = receivedTimestampMilliseconds / 1000;
        if (at > block.timestamp + MAX_PACKAGE_AHEAD) revert PackageFromFuture(at, block.timestamp);
        if (at + MAX_PACKAGE_AGE < block.timestamp) revert PackageTooOld(at, block.timestamp);
    }

    /// Chainlink's AggregatorV3 shape. Before the first update the answer is 0
    /// and updatedAt is 0, which a mandate treats as a broken price.
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        return (_round, _answer, _updatedAt, _updatedAt, _round);
    }
}
