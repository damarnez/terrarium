// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// A Chainlink-shaped price feed with a settable answer. The Terrarium installs it with anvil_setCode AT THE ADDRESS of a
/// real aggregator (so every consumer keeps reading "the oracle") and writes `answer`/`decimals` by storage layout.
contract FixedPriceFeed {
    int256 public answer;     // slot 0
    uint8 public decimals;    // slot 1
    uint256 public roundId;   // slot 2

    function latestAnswer() external view returns (int256) { return answer; }
    function latestTimestamp() external view returns (uint256) { return block.timestamp; }
    function latestRound() external view returns (uint256) { return roundId; }
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (uint80(roundId), answer, block.timestamp, block.timestamp, uint80(roundId));
    }
    function getRoundData(uint80) external view returns (uint80, int256, uint256, uint256, uint80) {
        return (uint80(roundId), answer, block.timestamp, block.timestamp, uint80(roundId));
    }
    function description() external pure returns (string memory) { return "Terrarium fixed price feed"; }
    function version() external pure returns (uint256) { return 1; }
}
