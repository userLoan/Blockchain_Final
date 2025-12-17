const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("LendingPlatform", function () {
  let lendingPlatform;
  let owner;
  let borrower;
  let lender;
  let loanAmount;
  let duration;
  let interestRate;

  beforeEach(async function () {
    [owner, borrower, lender] = await ethers.getSigners();
    
    const LendingPlatform = await ethers.getContractFactory("LendingPlatform");
    lendingPlatform = await LendingPlatform.deploy();
    await lendingPlatform.waitForDeployment();

    loanAmount = ethers.parseEther("1");
    duration = 30;
    interestRate = 5;
  });

  describe("Loan Requests", function () {
    it("Should create a loan request", async function () {
      const stake = ethers.parseEther("2");
      
      await lendingPlatform.connect(borrower).createLoanRequest(
        loanAmount,
        duration,
        interestRate,
        { value: stake }
      );

      const request = await lendingPlatform.loanRequests(0);
      expect(request.borrower).to.equal(borrower.address);
      expect(request.loanAmount).to.equal(loanAmount);
      expect(request.duration).to.equal(duration);
      expect(request.stake).to.equal(stake);
      expect(request.isActive).to.be.true;
      expect(request.interestRate).to.equal(interestRate);
    });

    it("Should revert if collateral is insufficient", async function () {
      const lowCollateral = ethers.parseEther("0.5");
      
      await expect(
        lendingPlatform.connect(borrower).createLoanRequest(
          loanAmount,
          duration,
          interestRate,
          { value: lowCollateral }
        )
      ).to.be.revertedWith("Insufficient collateral");
    });

    it("Should revert if loan amount is zero", async function () {
      const stake = ethers.parseEther("2");
      
      await expect(
        lendingPlatform.connect(borrower).createLoanRequest(
          0,
          duration,
          interestRate,
          { value: stake }
        )
      ).to.be.revertedWith("Loan amount must be greater than 0");
    });

    it("Should revert if duration is zero", async function () {
      const stake = ethers.parseEther("2");
      
      await expect(
        lendingPlatform.connect(borrower).createLoanRequest(
          loanAmount,
          0,
          interestRate,
          { value: stake }
        )
      ).to.be.revertedWith("Duration must be greater than 0");
    });

    it("Should revert if interest rate is zero", async function () {
      const stake = ethers.parseEther("2");
      
      await expect(
        lendingPlatform.connect(borrower).createLoanRequest(
          loanAmount,
          duration,
          0,
          { value: stake }
        )
      ).to.be.revertedWith("Interest rate must be greater than 0");
    });
  });

  describe("Loan Funding", function () {
    beforeEach(async function () {
      await lendingPlatform.connect(borrower).createLoanRequest(
        loanAmount,
        duration,
        interestRate,
        { value: ethers.parseEther("2") }
      );
    });

    it("Should fund a loan request", async function () {
      const initialEthPrice = ethers.parseEther("2000");
      
      await lendingPlatform.connect(lender).fundLoanRequest(
        0,
        initialEthPrice,
        { value: loanAmount }
      );

      const loan = await lendingPlatform.activeLoans(0);
      expect(loan.lender).to.equal(lender.address);
      expect(loan.borrower).to.equal(borrower.address);
      expect(loan.loanAmount).to.equal(loanAmount);
      expect(loan.interestRate).to.equal(interestRate);
    });

    it("Should transfer loan amount to borrower", async function () {
      const initialEthPrice = ethers.parseEther("2000");
      const borrowerBalanceBefore = await ethers.provider.getBalance(borrower.address);
      
      await lendingPlatform.connect(lender).fundLoanRequest(
        0,
        initialEthPrice,
        { value: loanAmount }
      );

      const borrowerBalanceAfter = await ethers.provider.getBalance(borrower.address);
      expect(borrowerBalanceAfter - borrowerBalanceBefore).to.equal(loanAmount);
    });

    it("Should revert if loan request doesn't exist", async function () {
      const initialEthPrice = ethers.parseEther("2000");
      
      await expect(
        lendingPlatform.connect(lender).fundLoanRequest(
          999,
          initialEthPrice,
          { value: loanAmount }
        )
      ).to.be.revertedWith("Request is not active");
    });

    it("Should revert if loan request is already funded", async function () {
      const initialEthPrice = ethers.parseEther("2000");
      
      await lendingPlatform.connect(lender).fundLoanRequest(
        0,
        initialEthPrice,
        { value: loanAmount }
      );

      await expect(
        lendingPlatform.connect(lender).fundLoanRequest(
          0,
          initialEthPrice,
          { value: loanAmount }
        )
      ).to.be.revertedWith("Request is not active");
    });

    it("Should revert if sent value doesn't match loan amount", async function () {
      const initialEthPrice = ethers.parseEther("2000");
      
      await expect(
        lendingPlatform.connect(lender).fundLoanRequest(
          0,
          initialEthPrice,
          { value: ethers.parseEther("0.5") }
        )
      ).to.be.revertedWith("Must send exact loan amount");
    });
  });

  describe("Loan Repayment", function () {
    beforeEach(async function () {
      await lendingPlatform.connect(borrower).createLoanRequest(
        loanAmount,
        duration,
        interestRate,
        { value: ethers.parseEther("2") }
      );

      await lendingPlatform.connect(lender).fundLoanRequest(
        0,
        ethers.parseEther("2000"),
        { value: loanAmount }
      );
    });

    it("Should repay a loan successfully", async function () {
      const interest = (loanAmount * BigInt(interestRate)) / BigInt(100);
      const repaymentAmount = loanAmount + interest;
      
      await lendingPlatform.connect(borrower).repayLoan(0, 0, {
        value: repaymentAmount
      });
      
      const loan = await lendingPlatform.activeLoans(0);
      expect(loan.isRepaid).to.be.true;
    });

    it("Should revert if non-borrower tries to repay", async function () {
      const interest = (loanAmount * BigInt(interestRate)) / BigInt(100);
      const repaymentAmount = loanAmount + interest;
      
      await expect(
        lendingPlatform.connect(lender).repayLoan(0, 0, {
          value: repaymentAmount
        })
      ).to.be.revertedWith("Only borrower can repay");
    });

    it("Should revert if loan is already repaid", async function () {
      const interest = (loanAmount * BigInt(interestRate)) / BigInt(100);
      const repaymentAmount = loanAmount + interest;
      
      await lendingPlatform.connect(borrower).repayLoan(0, 0, {
        value: repaymentAmount
      });

      await expect(
        lendingPlatform.connect(borrower).repayLoan(0, 0, {
          value: repaymentAmount
        })
      ).to.be.revertedWith("Loan already repaid");
    });
  });

  describe("Loan Liquidation", function () {
    beforeEach(async function () {
      await lendingPlatform.connect(borrower).createLoanRequest(
        loanAmount,
        duration,
        interestRate,
        { value: ethers.parseEther("2") }
      );

      await lendingPlatform.connect(lender).fundLoanRequest(
        0,
        ethers.parseEther("2000"),
        { value: loanAmount }
      );
    });

    it("Should liquidate expired loan", async function () {
      await network.provider.send("evm_increaseTime", [duration * 24 * 60 * 60 + 1]);
      await network.provider.send("evm_mine");

      const lenderBalanceBefore = await ethers.provider.getBalance(lender.address);
      
      await lendingPlatform.connect(owner).liquidateExpiredLoan(0);

      const lenderBalanceAfter = await ethers.provider.getBalance(lender.address);
      const loan = await lendingPlatform.activeLoans(0);

      expect(loan.isRepaid).to.be.true;
      expect(lenderBalanceAfter - lenderBalanceBefore).to.equal(ethers.parseEther("2")); // stake amount
    });

    it("Should revert if loan is not expired", async function () {
      await expect(
        lendingPlatform.connect(owner).liquidateExpiredLoan(0)
      ).to.be.revertedWith("Loan is not expired yet");
    });
  });
});