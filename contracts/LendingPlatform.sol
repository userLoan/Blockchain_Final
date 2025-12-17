// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "./LoanTypes.sol";
import "./LoanStorage.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";

contract LendingPlatform is LoanStorage {
    uint256 public constant MAX_INTEREST_RATE = 7;

    IERC721 public collateralNft;

    event LoanRequestCreated(
        uint256 indexed requestId,
        address indexed borrower,
        uint256 loanAmount,
        uint256 durationInDays,
        uint256 interestRate,
        uint256 collateralTokenId
    );

    event LoanRequestCancelled(
        uint256 indexed requestId,
        address indexed borrower,
        uint256 collateralTokenId
    );

    event LoanFunded(
        uint256 indexed loanId,
        uint256 indexed requestId,
        address indexed lender,
        address borrower,
        uint256 loanAmount,
        uint256 collateralTokenId
    );

    event LoanRepaid(
        uint256 indexed loanId,
        address indexed borrower,
        address indexed lender,
        uint256 repayAmount
    );

    event LoanLiquidated(
        uint256 indexed loanId,
        address indexed lender,
        uint256 collateralTokenId
    );

    constructor(address _collateralNft) {
        collateralNft = IERC721(_collateralNft);
    }

    // ====== BORROWER: CREATE REQUEST (NFT is transferred into contract as escrow) ======
    function createLoanRequest(
        uint256 _loanAmount,       // wei
        uint256 _durationInDays,
        uint256 _interestRate,     // %
        uint256 _collateralTokenId // ERC-721 tokenId
    ) external {
        require(_loanAmount > 0, "Loan amount must be greater than 0");
        require(_durationInDays > 0, "Duration must be greater than 0");
        require(_interestRate > 0 && _interestRate <= MAX_INTEREST_RATE, "Invalid interest rate");

        // Borrower must own the NFT
        require(collateralNft.ownerOf(_collateralTokenId) == msg.sender, "Not owner of NFT");

        // Platform must be approved for this tokenId (or approvedForAll)
        require(
            collateralNft.getApproved(_collateralTokenId) == address(this) ||
            collateralNft.isApprovedForAll(msg.sender, address(this)),
            "NFT not approved"
        );

        // Escrow the NFT into the contract
        collateralNft.transferFrom(msg.sender, address(this), _collateralTokenId);

        uint256 requestId = getNextRequestId();
        LoanTypes.LoanRequest storage request = loanRequests[requestId];

        request.borrower = msg.sender;
        request.loanAmount = _loanAmount;
        request.duration = _durationInDays;
        request.interestRate = _interestRate;
        request.isActive = true;
        request.collateralTokenId = _collateralTokenId;

        emit LoanRequestCreated(
            requestId,
            msg.sender,
            _loanAmount,
            _durationInDays,
            _interestRate,
            _collateralTokenId
        );
    }

    // ====== BORROWER: CANCEL REQUEST (if not funded yet, return NFT) ======
    function cancelLoanRequest(uint256 _requestId) external {
        LoanTypes.LoanRequest storage request = loanRequests[_requestId];

        require(request.isActive, "Request is not active");
        require(request.borrower == msg.sender, "Only borrower can cancel");

        request.isActive = false;

        uint256 tokenId = request.collateralTokenId;
        request.collateralTokenId = 0;

        collateralNft.transferFrom(address(this), msg.sender, tokenId);

        emit LoanRequestCancelled(_requestId, msg.sender, tokenId);
    }

    // ====== LENDER: FUND REQUEST (send exact ETH, NFT stays escrowed) ======
    function fundLoanRequest(uint256 _requestId) external payable {
        LoanTypes.LoanRequest storage request = loanRequests[_requestId];

        require(request.isActive, "Request is not active");
        require(msg.value == request.loanAmount, "Must send exact loan amount");

        uint256 loanId = getNextLoanId();
        LoanTypes.ActiveLoan storage loan = activeLoans[loanId];

        loan.borrower = request.borrower;
        loan.lender = msg.sender;
        loan.loanAmount = request.loanAmount;
        loan.collateralTokenId = request.collateralTokenId;
        loan.startTimestamp = block.timestamp;
        loan.endTime = block.timestamp + (request.duration * 1 days);
        loan.interestRate = request.interestRate;
        loan.isRepaid = false;

        request.isActive = false;

        (bool ok, ) = payable(request.borrower).call{value: msg.value}("");
        require(ok, "ETH transfer failed");

        emit LoanFunded(
            loanId,
            _requestId,
            msg.sender,
            loan.borrower,
            loan.loanAmount,
            loan.collateralTokenId
        );
    }

    // ====== REPAY CALC (simple interest, fixed) ======
    function _calculateRepayAmount(LoanTypes.ActiveLoan storage loan) internal view returns (uint256) {
        uint256 principal = loan.loanAmount;
        uint256 interest = (principal * loan.interestRate) / 100;
        return principal + interest;
    }

    function getRepayAmount(uint256 _loanId) external view returns (uint256) {
        LoanTypes.ActiveLoan storage loan = activeLoans[_loanId];
        require(!loan.isRepaid, "Loan already closed");
        return _calculateRepayAmount(loan);
    }

    // ====== BORROWER: REPAY (NO LATE REPAY) ======
    function repayLoan(uint256 _loanId) external payable {
        LoanTypes.ActiveLoan storage loan = activeLoans[_loanId];

        require(msg.sender == loan.borrower, "Only borrower can repay");
        require(!loan.isRepaid, "Loan already closed");
        require(block.timestamp <= loan.endTime, "Loan is expired");

        uint256 required = _calculateRepayAmount(loan);
        require(msg.value >= required, "Insufficient repay amount");

        loan.isRepaid = true;

        (bool ok, ) = payable(loan.lender).call{value: required}("");
        require(ok, "ETH transfer to lender failed");

        if (msg.value > required) {
            (bool ok2, ) = payable(msg.sender).call{value: msg.value - required}("");
            require(ok2, "Refund failed");
        }

        collateralNft.transferFrom(address(this), loan.borrower, loan.collateralTokenId);

        emit LoanRepaid(_loanId, loan.borrower, loan.lender, required);
    }

    // ====== LENDER: LIQUIDATE AFTER EXPIRY ======
    function liquidateExpiredLoan(uint256 _loanId) external {
        LoanTypes.ActiveLoan storage loan = activeLoans[_loanId];

        require(!loan.isRepaid, "Loan already closed");
        require(block.timestamp > loan.endTime, "Loan not expired");
        require(msg.sender == loan.lender, "Only lender can liquidate");

        loan.isRepaid = true;

        collateralNft.transferFrom(address(this), loan.lender, loan.collateralTokenId);

        emit LoanLiquidated(_loanId, loan.lender, loan.collateralTokenId);
    }

    // ====== VIEW HELPERS ======
    function checkLoanStatus(uint256 _loanId)
        external
        view
        returns (
            bool isClosed,
            uint256 loanAmount,
            uint256 startTimestamp,
            uint256 endTime,
            uint256 interestRate,
            uint256 collateralTokenId,
            address borrower,
            address lender
        )
    {
        LoanTypes.ActiveLoan storage loan = activeLoans[_loanId];
        return (
            loan.isRepaid,
            loan.loanAmount,
            loan.startTimestamp,
            loan.endTime,
            loan.interestRate,
            loan.collateralTokenId,
            loan.borrower,
            loan.lender
        );
    }

    function getBorrowerRequests(address _borrower)
        external
        view
        returns (uint256[] memory requestIds, LoanTypes.LoanRequest[] memory requests)
    {
        uint256 count = 0;
        for (uint256 i = 0; i < totalRequests; i++) {
            if (loanRequests[i].borrower == _borrower) {
                count++;
            }
        }

        requestIds = new uint256[](count);
        requests = new LoanTypes.LoanRequest[](count);

        uint256 idx = 0;
        for (uint256 i = 0; i < totalRequests; i++) {
            if (loanRequests[i].borrower == _borrower) {
                requestIds[idx] = i;
                requests[idx] = loanRequests[i];
                idx++;
            }
        }
    }

    function getAllActive()
        external
        view
        returns (
            uint256[] memory loanIds,
            LoanTypes.ActiveLoan[] memory loans,
            uint256[] memory requestIds,
            LoanTypes.LoanRequest[] memory requests
        )
    {
        uint256 activeLoanCount = 0;
        uint256 activeRequestCount = 0;

        for (uint256 i = 0; i < totalLoans; i++) {
            if (!activeLoans[i].isRepaid) {
                activeLoanCount++;
            }
        }
        for (uint256 i = 0; i < totalRequests; i++) {
            if (loanRequests[i].isActive) {
                activeRequestCount++;
            }
        }

        loanIds = new uint256[](activeLoanCount);
        loans = new LoanTypes.ActiveLoan[](activeLoanCount);
        requestIds = new uint256[](activeRequestCount);
        requests = new LoanTypes.LoanRequest[](activeRequestCount);

        uint256 li = 0;
        for (uint256 i = 0; i < totalLoans; i++) {
            if (!activeLoans[i].isRepaid) {
                loanIds[li] = i;
                loans[li] = activeLoans[i];
                li++;
            }
        }

        uint256 ri = 0;
        for (uint256 i = 0; i < totalRequests; i++) {
            if (loanRequests[i].isActive) {
                requestIds[ri] = i;
                requests[ri] = loanRequests[i];
                ri++;
            }
        }
    }
}
