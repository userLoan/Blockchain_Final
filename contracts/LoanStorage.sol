// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "./LoanTypes.sol";

contract LoanStorage {
    mapping(uint256 => LoanTypes.LoanRequest) internal loanRequests;
    mapping(uint256 => LoanTypes.ActiveLoan) internal activeLoans;

    uint256 internal totalRequests;
    uint256 internal totalLoans;

    function getNextRequestId() internal returns (uint256) {
        uint256 id = totalRequests;
        totalRequests += 1;
        return id;
    }

    function getNextLoanId() internal returns (uint256) {
        uint256 id = totalLoans;
        totalLoans += 1;
        return id;
    }

    function getTotalRequests() external view returns (uint256) {
        return totalRequests;
    }

    function getTotalLoans() external view returns (uint256) {
        return totalLoans;
    }
}
