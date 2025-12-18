// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC721/IERC721.sol";

contract LendingPlatform {
    uint256 public constant MAX_INTEREST_RATE = 7;
    uint256 public constant REQUEST_EXPIRY = 2 days;

    IERC721 public collateralNft;

    enum RequestStatus {
        NONE,      // 0
        ACTIVE,    // 1
        FUNDED,    // 2
        CANCELLED, // 3
        EXPIRED    // 4
    }

    struct LoanRequest {
        address borrower;
        uint256 loanAmount;       // wei
        uint256 durationInDays;   // days
        uint256 interestRate;     // %
        uint256 collateralTokenId;
        bool isActive;            // pending (not funded)
    }

    struct ActiveLoan {
        address borrower;
        address lender;
        uint256 loanAmount;       // wei
        uint256 collateralTokenId;
        uint256 startTimestamp;
        uint256 endTime;
        uint256 interestRate;     // %
        bool isRepaid;
    }

    // Storage
    mapping(uint256 => LoanRequest) public loanRequests;
    mapping(uint256 => ActiveLoan) public activeLoans;

    uint256 public totalRequests;
    uint256 public totalLoans;

    // For expiry + UI
    mapping(uint256 => uint256) public requestCreatedAt;   // requestId -> timestamp
    mapping(uint256 => RequestStatus) public requestStatus; // requestId -> enum

    // Optional index for borrower
    mapping(address => uint256[]) private borrowerRequestIds;

    // Events
    event LoanRequestCreated(
        uint256 indexed requestId,
        address indexed borrower,
        uint256 loanAmount,
        uint256 durationInDays,
        uint256 interestRate,
        uint256 collateralTokenId,
        uint256 createdAt
    );

    event LoanRequestCancelled(
        uint256 indexed requestId,
        address indexed borrower,
        uint256 collateralTokenId
    );

    event LoanRequestExpired(
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

    // ====== BORROWER: CREATE REQUEST (escrow NFT) ======
    function createLoanRequest(
        uint256 _loanAmount,
        uint256 _durationInDays,
        uint256 _interestRate,
        uint256 _collateralTokenId
    ) external {
        require(_loanAmount > 0, "Loan amount must be greater than 0");
        require(_durationInDays > 0, "Duration must be greater than 0");
        require(_interestRate > 0 && _interestRate <= MAX_INTEREST_RATE, "Invalid interest rate");

        // Borrower must own NFT
        require(collateralNft.ownerOf(_collateralTokenId) == msg.sender, "Not owner of NFT");

        // Approved
        require(
            collateralNft.getApproved(_collateralTokenId) == address(this) ||
            collateralNft.isApprovedForAll(msg.sender, address(this)),
            "NFT not approved"
        );

        // Escrow NFT
        collateralNft.transferFrom(msg.sender, address(this), _collateralTokenId);

        uint256 requestId = totalRequests;
        totalRequests++;

        LoanRequest storage request = loanRequests[requestId];
        request.borrower = msg.sender;
        request.loanAmount = _loanAmount;
        request.durationInDays = _durationInDays;
        request.interestRate = _interestRate;
        request.collateralTokenId = _collateralTokenId;
        request.isActive = true;

        requestCreatedAt[requestId] = block.timestamp;
        requestStatus[requestId] = RequestStatus.ACTIVE;

        borrowerRequestIds[msg.sender].push(requestId);

        emit LoanRequestCreated(
            requestId,
            msg.sender,
            _loanAmount,
            _durationInDays,
            _interestRate,
            _collateralTokenId,
            block.timestamp
        );
    }

    // ====== ANYONE: EXPIRE REQUEST AFTER 2 DAYS (return NFT to borrower) ======
    function expireLoanRequest(uint256 _requestId) external {
        LoanRequest storage request = loanRequests[_requestId];

        require(request.isActive, "Request is not active");
        require(requestStatus[_requestId] == RequestStatus.ACTIVE, "Not ACTIVE");

        uint256 createdAt = requestCreatedAt[_requestId];
        require(createdAt != 0, "Missing createdAt");
        require(block.timestamp > createdAt + REQUEST_EXPIRY, "Not expired yet");

        request.isActive = false;
        requestStatus[_requestId] = RequestStatus.EXPIRED;

        // Return NFT
        collateralNft.transferFrom(address(this), request.borrower, request.collateralTokenId);

        emit LoanRequestExpired(_requestId, request.borrower, request.collateralTokenId);
    }

    // ====== BORROWER: CANCEL REQUEST (return NFT) ======
    function cancelLoanRequest(uint256 _requestId) external {
        LoanRequest storage request = loanRequests[_requestId];

        require(request.isActive, "Request is not active");
        require(request.borrower == msg.sender, "Only borrower can cancel");
        require(requestStatus[_requestId] == RequestStatus.ACTIVE, "Not ACTIVE");

        request.isActive = false;
        requestStatus[_requestId] = RequestStatus.CANCELLED;

        collateralNft.transferFrom(address(this), msg.sender, request.collateralTokenId);

        emit LoanRequestCancelled(_requestId, msg.sender, request.collateralTokenId);
    }

    // ====== LENDER: FUND REQUEST (must be within 2 days) ======
    function fundLoanRequest(uint256 _requestId) external payable {
        LoanRequest storage request = loanRequests[_requestId];

        require(request.isActive, "Request is not active");
        require(requestStatus[_requestId] == RequestStatus.ACTIVE, "Not ACTIVE");

        uint256 createdAt = requestCreatedAt[_requestId];
        require(createdAt != 0, "Missing createdAt");
        require(block.timestamp <= createdAt + REQUEST_EXPIRY, "Request expired");

        require(msg.value == request.loanAmount, "Must send exact loan amount");

        uint256 loanId = totalLoans;
        totalLoans++;

        ActiveLoan storage loan = activeLoans[loanId];
        loan.borrower = request.borrower;
        loan.lender = msg.sender;
        loan.loanAmount = request.loanAmount;
        loan.collateralTokenId = request.collateralTokenId;
        loan.startTimestamp = block.timestamp;
        loan.endTime = block.timestamp + (request.durationInDays * 1 days);
        loan.interestRate = request.interestRate;
        loan.isRepaid = false;

        request.isActive = false;
        requestStatus[_requestId] = RequestStatus.FUNDED;

        (bool ok, ) = payable(request.borrower).call{ value: msg.value }("");
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

    // ====== REPAY CALC ======
    function _calculateRepayAmount(ActiveLoan storage loan) internal view returns (uint256) {
        uint256 principal = loan.loanAmount;
        uint256 interest = (principal * loan.interestRate) / 100;
        return principal + interest;
    }

    function getRepayAmount(uint256 _loanId) external view returns (uint256) {
        ActiveLoan storage loan = activeLoans[_loanId];
        require(!loan.isRepaid, "Loan already closed");
        return _calculateRepayAmount(loan);
    }

    // ====== BORROWER: REPAY (no late repay) ======
    function repayLoan(uint256 _loanId) external payable {
        ActiveLoan storage loan = activeLoans[_loanId];

        require(msg.sender == loan.borrower, "Only borrower can repay");
        require(!loan.isRepaid, "Loan already closed");
        require(block.timestamp <= loan.endTime, "Loan is expired");

        uint256 required = _calculateRepayAmount(loan);
        require(msg.value >= required, "Insufficient repay amount");

        loan.isRepaid = true;

        (bool ok, ) = payable(loan.lender).call{ value: required }("");
        require(ok, "ETH transfer to lender failed");

        if (msg.value > required) {
            (bool ok2, ) = payable(msg.sender).call{ value: msg.value - required }("");
            require(ok2, "Refund failed");
        }

        collateralNft.transferFrom(address(this), loan.borrower, loan.collateralTokenId);

        emit LoanRepaid(_loanId, loan.borrower, loan.lender, required);
    }

    // ====== LENDER: LIQUIDATE AFTER EXPIRY ======
    function liquidateExpiredLoan(uint256 _loanId) external {
        ActiveLoan storage loan = activeLoans[_loanId];

        require(!loan.isRepaid, "Loan already closed");
        require(block.timestamp > loan.endTime, "Loan not expired");
        require(msg.sender == loan.lender, "Only lender can liquidate");

        loan.isRepaid = true;

        collateralNft.transferFrom(address(this), loan.lender, loan.collateralTokenId);

        emit LoanLiquidated(_loanId, loan.lender, loan.collateralTokenId);
    }

    // ====== VIEW: Borrower requests ======
    function getBorrowerRequests(address _borrower)
        external
        view
        returns (uint256[] memory requestIds, LoanRequest[] memory requests)
    {
        uint256[] storage ids = borrowerRequestIds[_borrower];
        requestIds = new uint256[](ids.length);
        requests = new LoanRequest[](ids.length);

        for (uint256 i = 0; i < ids.length; i++) {
            uint256 rid = ids[i];
            requestIds[i] = rid;
            requests[i] = loanRequests[rid];
        }
    }

    // ====== VIEW: All requests (for Lender UI to show EXPIRED / FUNDED / CANCELLED) ======
    function getAllRequests()
        external
        view
        returns (uint256[] memory requestIds, LoanRequest[] memory requests)
    {
        requestIds = new uint256[](totalRequests);
        requests = new LoanRequest[](totalRequests);

        for (uint256 i = 0; i < totalRequests; i++) {
            requestIds[i] = i;
            requests[i] = loanRequests[i];
        }
    }

    // ====== VIEW: Active loans + active requests (kept for compatibility) ======
    function getAllActive()
        external
        view
        returns (
            uint256[] memory loanIds,
            ActiveLoan[] memory loans,
            uint256[] memory requestIds,
            LoanRequest[] memory requests
        )
    {
        uint256 activeLoanCount = 0;
        uint256 activeRequestCount = 0;

        for (uint256 i = 0; i < totalLoans; i++) {
            if (!activeLoans[i].isRepaid) activeLoanCount++;
        }
        for (uint256 i = 0; i < totalRequests; i++) {
            if (loanRequests[i].isActive) activeRequestCount++;
        }

        loanIds = new uint256[](activeLoanCount);
        loans = new ActiveLoan[](activeLoanCount);
        requestIds = new uint256[](activeRequestCount);
        requests = new LoanRequest[](activeRequestCount);

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
