import React, { useEffect, useMemo, useState } from "react";
import { Container, Button, Table, Card, Badge, Toast } from "react-bootstrap";
import { ethers } from "ethers";

import LendingPlatformABI from "../contracts/LendingPlatform.abi.json";
import TokenNFTABI from "../contracts/TokenNFT.abi.json";
import addresses from "../contracts/contract-address.json";

// Support both deploy output styles
const LENDING_ADDRESS = addresses.LendingPlatform || addresses.lendingPlatformAddress;
const NFT_ADDRESS = addresses.TokenNFT || addresses.tokenNftAddress;

const STATUS = {
  NONE: 0,
  ACTIVE: 1,
  FUNDED: 2,
  CANCELLED: 3,
  EXPIRED: 4,
};

function extractRevertReason(err) {
  const data = err?.error?.data || err?.data || err?.error?.error?.data;
  const msg = err?.error?.message || err?.message || "";

  const m1 = msg.match(/reverted(?: with reason string)?(?::| )['"]?([^'"]+)['"]?/i);
  if (m1?.[1]) return m1[1];

  try {
    const body = err?.error?.body;
    if (typeof body === "string") {
      const j = JSON.parse(body);
      const m2 = j?.error?.message?.match(/reverted(?: with reason string)?(?::| )['"]?([^'"]+)['"]?/i);
      if (m2?.[1]) return m2[1];
    }
  } catch (_) {}

  if (data && typeof data === "string" && data.startsWith("0x08c379a0")) {
    try {
      const reason = ethers.utils.defaultAbiCoder.decode(["string"], "0x" + data.slice(10))[0];
      if (reason) return reason;
    } catch (_) {}
  }

  return msg || "Transaction failed";
}

async function getOwnedTokenIds(nft, owner) {
  const owned = [];
  let nextId = 1;

  try {
    nextId = (await nft.nextTokenId()).toNumber();
  } catch (_) {
    nextId = 1;
  }

  for (let id = 1; id < nextId; id++) {
    try {
      const o = await nft.ownerOf(id);
      if (o && o.toLowerCase() === owner.toLowerCase()) owned.push(id);
    } catch (_) {}
  }
  return owned;
}

const Lender = () => {
  const [account, setAccount] = useState("");
  const [ethBalance, setEthBalance] = useState("");
  const [nftCount, setNftCount] = useState(0);
  const [ownedTokenIds, setOwnedTokenIds] = useState([]);

  const [lendingContract, setLendingContract] = useState(null);
  const [nftContract, setNftContract] = useState(null);

  const [requests, setRequests] = useState([]);
  const [activeLoans, setActiveLoans] = useState([]);

  const [autoExpireBusy, setAutoExpireBusy] = useState(false);

  const [toast, setToast] = useState({ show: false, message: "", variant: "success" });
  const showToast = (message, variant = "success") => setToast({ show: true, message, variant });

  const provider = useMemo(() => {
    if (!window.ethereum) return null;
    return new ethers.providers.Web3Provider(window.ethereum);
  }, []);

  useEffect(() => {
    const init = async () => {
      if (!provider) return;

      const accs = await provider.listAccounts();
      if (!accs || accs.length === 0) {
        try {
          await provider.send("eth_requestAccounts", []);
        } catch (_) {
          return;
        }
      }

      const accounts = await provider.listAccounts();
      if (!accounts || accounts.length === 0) return;

      const addr = accounts[0];
      setAccount(addr);

      const signer = provider.getSigner();
      setLendingContract(new ethers.Contract(LENDING_ADDRESS, LendingPlatformABI, signer));
      setNftContract(new ethers.Contract(NFT_ADDRESS, TokenNFTABI, signer));
    };

    init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  const nowTs = async () => {
    if (!provider) return Math.floor(Date.now() / 1000);
    try {
      const b = await provider.getBlock("latest");
      return Number(b.timestamp);
    } catch {
      return Math.floor(Date.now() / 1000);
    }
  };

  const updateBalances = async () => {
    if (!provider || !nftContract || !account) return;

    const bal = await provider.getBalance(account);
    setEthBalance(ethers.utils.formatEther(bal));

    const c = await nftContract.balanceOf(account);
    setNftCount(c.toNumber());

    const ids = await getOwnedTokenIds(nftContract, account);
    setOwnedTokenIds(ids);
  };

  const loadAll = async (skipAuto = false) => {
    if (!lendingContract) return;

    const chainNow = await nowTs();

    // Active loans
    const allActive = await lendingContract.getAllActive();
    const loanIds = allActive[0];
    const loans = allActive[1];

    const mappedLoans = loans.map((l, i) => ({
      loanId: loanIds[i].toNumber(),
      borrower: l.borrower,
      lender: l.lender,
      loanAmountWei: l.loanAmount,
      loanAmount: ethers.utils.formatEther(l.loanAmount),
      endTime: l.endTime.toNumber(),
      interestRate: l.interestRate.toNumber(),
      collateralTokenId: l.collateralTokenId.toNumber(),
      isExpired: chainNow > l.endTime.toNumber(),
    }));
    setActiveLoans(mappedLoans);

    // All requests (for lender)
    const allReq = await lendingContract.getAllRequests();
    const requestIds = allReq[0];
    const reqs = allReq[1];

    const expiry = await lendingContract.REQUEST_EXPIRY();

    const createdArr = await Promise.all(requestIds.map((id) => lendingContract.requestCreatedAt(id)));
    const statusArr = await Promise.all(requestIds.map((id) => lendingContract.requestStatus(id)));

    const mappedReqs = reqs.map((r, i) => {
      const requestId = requestIds[i].toNumber();
      const createdAt = Number(createdArr[i]);
      const statusCode = Number(statusArr[i]);
      const expiresAt = createdAt > 0 ? createdAt + Number(expiry) : 0;

      const expiredByTime = statusCode === STATUS.ACTIVE && createdAt > 0 && chainNow > expiresAt;

      return {
        requestId,
        borrower: r.borrower,
        loanAmountWei: r.loanAmount,
        loanAmount: ethers.utils.formatEther(r.loanAmount),
        duration: r.durationInDays ? r.durationInDays.toNumber() : r.duration?.toNumber?.() ?? 0,
        interestRate: r.interestRate.toNumber(),
        collateralTokenId: r.collateralTokenId.toNumber(),
        isActive: r.isActive,
        statusCode,
        createdAt,
        expiresAt,
        expiredByTime,
      };
    });

    // Sort: pending first
    mappedReqs.sort((a, b) => (b.statusCode === STATUS.ACTIVE) - (a.statusCode === STATUS.ACTIVE));
    setRequests(mappedReqs);

    // Auto-expire (finalize return) for any expired ACTIVE requests
    if (!skipAuto && !autoExpireBusy) {
      const target = mappedReqs.find((x) => x.isActive && x.statusCode === STATUS.ACTIVE && x.expiredByTime);
      if (target) {
        setAutoExpireBusy(true);
        try {
          const tx = await lendingContract.expireLoanRequest(target.requestId);
          await tx.wait();
          showToast(`Request #${target.requestId} expired. NFT returned to borrower.`, "success");
        } catch (e) {
          console.error(e);
          showToast(extractRevertReason(e), "danger");
        } finally {
          setAutoExpireBusy(false);
        }

        await updateBalances();
        await loadAll(true);
        return;
      }
    }
  };

  useEffect(() => {
    if (!account || !lendingContract || !nftContract) return;
    (async () => {
      await updateBalances();
      await loadAll();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, lendingContract, nftContract]);

  const fund = async (request) => {
    if (!lendingContract) return;
    try {
      const tx = await lendingContract.fundLoanRequest(request.requestId, { value: request.loanAmountWei });
      await tx.wait();
      showToast("Loan funded successfully", "success");
      await updateBalances();
      await loadAll();
    } catch (e) {
      console.error(e);
      showToast(extractRevertReason(e), "danger");
    }
  };

  const expireRequest = async (requestId) => {
    if (!lendingContract) return;
    try {
      const tx = await lendingContract.expireLoanRequest(requestId);
      await tx.wait();
      showToast("Request expired. NFT returned to borrower.", "success");
      await updateBalances();
      await loadAll();
    } catch (e) {
      console.error(e);
      showToast(extractRevertReason(e), "danger");
    }
  };

  const liquidate = async (loanId) => {
    if (!lendingContract) return;
    try {
      const tx = await lendingContract.liquidateExpiredLoan(loanId);
      await tx.wait();
      showToast("Loan liquidated. NFT transferred to lender.", "success");
      await updateBalances();
      await loadAll();
    } catch (e) {
      console.error(e);
      showToast(extractRevertReason(e), "danger");
    }
  };

  const renderReqStatus = (r) => {
    // Lender requirement: nếu quá 2 ngày chưa fund => EXPIRED
    if (r.statusCode === STATUS.ACTIVE && r.expiredByTime) {
      return <Badge bg="warning" text="dark">EXPIRED</Badge>;
    }
    if (r.statusCode === STATUS.ACTIVE) return <Badge bg="success">PENDING</Badge>;
    if (r.statusCode === STATUS.EXPIRED) return <Badge bg="warning" text="dark">EXPIRED</Badge>;
    if (r.statusCode === STATUS.FUNDED) return <Badge bg="info">FUNDED</Badge>;
    if (r.statusCode === STATUS.CANCELLED) return <Badge bg="secondary">CANCELLED</Badge>;
    return <Badge bg="secondary">UNKNOWN</Badge>;
  };

  const renderReqAction = (r) => {
    if (r.statusCode === STATUS.ACTIVE && r.expiredByTime) {
      // UI will auto-trigger; keep a manual fallback button
      return (
        <Button
          variant="outline-warning"
          size="sm"
          disabled={autoExpireBusy}
          onClick={() => expireRequest(r.requestId)}
        >
          Return Collateral
        </Button>
      );
    }
    if (r.statusCode === STATUS.ACTIVE && !r.expiredByTime) {
      return <Button size="sm" onClick={() => fund(r)}>Fund</Button>;
    }
    return "-";
  };

  return (
    <Container className="py-4">
      <Card className="mb-4">
        <Card.Header><strong>Lender Dashboard</strong></Card.Header>
        <Card.Body>
          <div><strong>Connected Account:</strong> {account}</div>
          <div className="mt-2"><strong>ETH Balance:</strong> {ethBalance} ETH</div>
          <div className="mt-2"><strong>NFT Balance:</strong> {nftCount} TokenNFT</div>
          <div className="mt-2">
            <strong>Owned tokenIds:</strong> {ownedTokenIds.length ? ownedTokenIds.join(", ") : "None"}
          </div>
        </Card.Body>
      </Card>

      <Card className="mb-4">
        <Card.Header><strong>All Loan Requests</strong></Card.Header>
        <Card.Body>
          <Button variant="outline-primary" size="sm" className="mb-2" onClick={loadAll}>
            Refresh
          </Button>

          <Table bordered hover>
            <thead>
              <tr>
                <th>Request ID</th>
                <th>Borrower</th>
                <th>Amount (ETH)</th>
                <th>Duration (days)</th>
                <th>Interest</th>
                <th>Collateral tokenId</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {requests.length === 0 ? (
                <tr><td colSpan="8">No requests found.</td></tr>
              ) : (
                requests.map((r) => (
                  <tr key={r.requestId}>
                    <td>{r.requestId}</td>
                    <td>{r.borrower}</td>
                    <td>{r.loanAmount}</td>
                    <td>{r.duration}</td>
                    <td>{r.interestRate}%</td>
                    <td>{r.collateralTokenId}</td>
                    <td>{renderReqStatus(r)}</td>
                    <td>{renderReqAction(r)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </Table>
        </Card.Body>
      </Card>

      <Card className="mb-4">
        <Card.Header><strong>Active Loans</strong></Card.Header>
        <Card.Body>
          <Button variant="outline-primary" size="sm" className="mb-2" onClick={loadAll}>
            Refresh
          </Button>

          <Table bordered hover>
            <thead>
              <tr>
                <th>Loan ID</th>
                <th>Borrower</th>
                <th>Amount (ETH)</th>
                <th>Interest</th>
                <th>End Time</th>
                <th>Collateral tokenId</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {activeLoans.length === 0 ? (
                <tr><td colSpan="7">No active loans.</td></tr>
              ) : (
                activeLoans.map((l) => (
                  <tr key={l.loanId}>
                    <td>{l.loanId}</td>
                    <td>{l.borrower}</td>
                    <td>{l.loanAmount}</td>
                    <td>{l.interestRate}%</td>
                    <td>{new Date(l.endTime * 1000).toLocaleString()}</td>
                    <td>{l.collateralTokenId}</td>
                    <td>
                      {l.isExpired ? (
                        <Button size="sm" variant="danger" onClick={() => liquidate(l.loanId)}>
                          Liquidate
                        </Button>
                      ) : (
                        "-"
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </Table>
        </Card.Body>
      </Card>

      <Toast
        show={toast.show}
        onClose={() => setToast((p) => ({ ...p, show: false }))}
        delay={3500}
        autohide
        style={{ position: "fixed", top: 20, right: 20, minWidth: 260 }}
      >
        <Toast.Header closeButton={true}>
          <strong className="me-auto">Notification</strong>
        </Toast.Header>
        <Toast.Body style={{ color: toast.variant === "danger" ? "crimson" : "inherit" }}>
          {toast.message}
        </Toast.Body>
      </Toast>
    </Container>
  );
};

export default Lender;
