// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

library LoanTypes {
    struct LoanRequest {
        address borrower;
        uint256 loanAmount;        // wei (ETH)
        uint256 duration;          // days
        uint256 interestRate;      // %
        bool isActive;
        uint256 collateralTokenId; // ERC-721 tokenId held as collateral in the platform contract
    }

    struct ActiveLoan {
        address borrower;
        address lender;
        uint256 loanAmount;        // wei (ETH)
        uint256 collateralTokenId; // ERC-721 tokenId held as collateral in the platform contract
        uint256 startTimestamp;    // unix seconds
        uint256 endTime;           // unix seconds
        uint256 interestRate;      // %
        bool isRepaid;             // repaid OR liquidated
    }
}
