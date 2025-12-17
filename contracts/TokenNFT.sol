// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @notice Demo NFT that represents a real-world asset claim (off-chain). Each tokenId is a unique collateral item.
contract TokenNFT is ERC721 {
    uint256 public nextTokenId = 1;

    constructor() ERC721("Token", "TOKEN") {}

    /// @notice Open mint for demo/testing. Mints a new NFT to msg.sender and returns the tokenId.
    function mint() external returns (uint256 tokenId) {
        tokenId = nextTokenId;
        nextTokenId += 1;
        _safeMint(msg.sender, tokenId);
    }
}
