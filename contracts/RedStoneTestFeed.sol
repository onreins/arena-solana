// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {RedStonePriceFeed} from "./RedStonePriceFeed.sol";

/**
 * RedStonePriceFeed for tests: everything the same, except that it trusts five
 * signers the test chooses instead of RedStone's production signers, so tests
 * can sign packages with throwaway keys. Never deploy it anywhere real.
 */
contract RedStoneTestFeed is RedStonePriceFeed {
    address private immutable _s0;
    address private immutable _s1;
    address private immutable _s2;
    address private immutable _s3;
    address private immutable _s4;

    constructor(bytes32 dataFeedId_, address[5] memory signers) RedStonePriceFeed(dataFeedId_, "test feed") {
        (_s0, _s1, _s2, _s3, _s4) = (signers[0], signers[1], signers[2], signers[3], signers[4]);
    }

    function getAuthorisedSignerIndex(address signer) public view override returns (uint8) {
        if (signer == _s0) return 0;
        if (signer == _s1) return 1;
        if (signer == _s2) return 2;
        if (signer == _s3) return 3;
        if (signer == _s4) return 4;
        revert SignerNotAuthorised(signer);
    }
}

interface ILatestRound {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

/// A stand-in for a mandate's public stop-loss in tests: freezes only when the
/// feed's price is below `floorPrice`, reading the feed at the moment of the call.
contract CheckpointProbe {
    ILatestRound public immutable feed;
    int256 public immutable floorPrice;
    bool public frozen;

    error NotBreached();

    constructor(ILatestRound feed_, int256 floorPrice_) {
        feed = feed_;
        floorPrice = floorPrice_;
    }

    function checkpoint() external {
        (, int256 answer,,,) = feed.latestRoundData();
        if (answer >= floorPrice) revert NotBreached();
        frozen = true;
    }
}
