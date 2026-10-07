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
