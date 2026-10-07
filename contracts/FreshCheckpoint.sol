// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IRedStonePriceFeed {
    function updatePrice() external returns (int256 answer, uint256 updatedAt);
}

interface IMandateCheckpoint {
    function checkpoint() external;
}

/**
 * The public stop-loss with a fresh price, in one transaction.
 *
 * Anyone may call a mandate's checkpoint() to freeze it once its equity is
 * below its loss floor. Equity is priced by the mandate's feed, and a RedStone
 * feed only moves when someone pushes it a signed price, so a checkpoint on
 * its own could judge the agent on a price from minutes ago. This pushes the
 * RedStone payload appended to this call into the feed first, then runs the
 * checkpoint, atomically: the freeze is decided on a price seconds old, and if
 * the mandate isn't below its floor the whole call reverts (NotBreached) and
 * nothing changes. It holds nothing and has no owner.
 */
contract FreshCheckpoint {
    /// The RedStone payload follows the two address arguments in calldata.
    uint256 private constant ARGS_END = 4 + 32 + 32;

    function refreshAndCheckpoint(address feed, address mandate) external {
        bytes calldata payload = msg.data[ARGS_END:];
        (bool ok, bytes memory reason) =
            feed.call(abi.encodePacked(IRedStonePriceFeed.updatePrice.selector, payload));
        if (!ok) {
            assembly {
                revert(add(reason, 32), mload(reason))
            }
        }
        IMandateCheckpoint(mandate).checkpoint();
    }
}
