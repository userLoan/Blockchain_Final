// frontend/src/components/Lender.js
import React, { useEffect, useMemo, useState } from "react";
import { Container, Table, Button, Card, Badge, Toast } from "react-bootstrap";
import { ethers } from "ethers";

import LendingPlatformABI from "../contracts/LendingPlatform.abi.json";
import TokenNFTABI from "../contracts/TokenNFT.abi.json";
import addresses from "../contracts/contract-address.json";

const LENDING_ADDRESS = addresses.LendingPlatform || addresses.lendingPlatformAddress;
const NFT_ADDRESS = addresses.TokenNFT || addresses.tokenNftAddress;

// -------- helpers (avoid BigNumber undefined crashes) --------
const toInt = (v, fallback = 0) => {
  if (v === null || v === undefined) return fallback;
  try {
    if (typeof v === "number") return v;
    if (typeof v === "bigint") return Number(v);
    if (typeof v === "string") return Number(v);
    if (v.toNumber) return v.toNumber();
    if (v.toString) return Number(v.toString());
  } catch (_) {}
  return fallback;
};

const tuple = (res, key, idx, fb) => (res ? (res[key] ?? res[idx] ?? fb) : fb);
// ---------------- Asset naming (UI-only) ----------------
const DEFAULT_ASSET_BY_TOKEN_ID = {
  1: "Gold",
  2: "Silver",
  3: "Car",
  4: "Motorbike",
  5: "House",
};

function storageKey(chainId, nftAddress) {
  const cid = chainId ?? "unknown";
  return `dloan_nft_names_${cid}_${String(nftAddress || "").toLowerCase()}`;
}

function safeJsonParse(s, fallback) {
  try { return JSON.parse(s); } catch (_) { return fallback; }
}

function loadNameMap(chainId, nftAddress) {
  if (!nftAddress) return {};
  const key = storageKey(chainId, nftAddress);
  return safeJsonParse(window.localStorage.getItem(key) || "{}", {});
}

function tokenDisplayName(chainId, nftAddress, tokenId) {
  const id = Number(tokenId);
  const map = loadNameMap(chainId, nftAddress);
  return map[String(tokenId)] || DEFAULT_ASSET_BY_TOKEN_ID[id] || `Token ${id}`;
}

function extractRevertReason(err) {
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
  return msg || "Transaction failed";
}

async function getOwnedTokenIds(nft, owner) {
  const owned = [];
  let nextId = 1;
  try {
    nextId = toInt(await nft.nextTokenId());
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

  const [chainId, setChainId] = useState(null);

  const [lendingContract, setLendingContract] = useState(null);
  const [nftContract, setNftContract] = useState(null);

  const [requests, setRequests] = useState([]);
  const [activeLoans, setActiveLoans] = useState([]);

  const [toast, setToast] = useState({ show: false, message: "", variant: "success" });
  const showToast = (message, variant = "success") => setToast({ show: true, message, variant });

  const provider = useMemo(() => {
    if (!window.ethereum) return null;
    return new ethers.providers.Web3Provider(window.ethereum);
  }, []);

  useEffect(() => {
    const init = async () => {
      if (!provider) return;

      try {
        const network = await provider.getNetwork();
        setChainId(network.chainId);
      } catch (_) {}

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

  const updateBalances = async () => {
    if (!provider || !nftContract || !account) return;
    const bal = await provider.getBalance(account);
    setEthBalance(ethers.utils.formatEther(bal));

    const c = await nftContract.balanceOf(account);
    setNftCount(toInt(c));

    const ids = await getOwnedTokenIds(nftContract, account);
    setOwnedTokenIds(ids);
  };

  const loadAll = async () => {
    if (!lendingContract) return;

    const all = await lendingContract.getAllActive();

    const loanIds = tuple(all, 'loanIds', 0, []);
    const loans = tuple(all, 'loans', 1, []);
    const requestIds = tuple(all, 'requestIds', 2, []);
    const reqs = tuple(all, 'requests', 3, []);

    const mappedReqs = (reqs || [])
      .map((r, i) => {
        const rid = (requestIds || [])[i];
        if (!rid || !r) return null;
        return {
          requestId: toInt(rid),
          borrower: r.borrower,
          loanAmountWei: r.loanAmount,
          loanAmount: ethers.utils.formatEther(r.loanAmount),
          duration: toInt(r.duration),
          interestRate: toInt(r.interestRate),
          collateralTokenId: toInt(r.collateralTokenId),
          isActive: r.isActive,
        };
      })
      .filter(Boolean);

    const mappedLoans = (loans || [])
      .map((l, i) => {
        const lid = (loanIds || [])[i];
        if (!lid || !l) return null;
        return {
          loanId: toInt(lid),
          borrower: l.borrower,
          lender: l.lender,
          loanAmount: ethers.utils.formatEther(l.loanAmount),
          endTime: toInt(l.endTime),
          interestRate: toInt(l.interestRate),
          collateralTokenId: toInt(l.collateralTokenId),
        };
      })
      .filter(Boolean);

    setRequests(mappedReqs);
    setActiveLoans(mappedLoans);
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

  const nowTs = async () => {
    if (!provider) return Math.floor(Date.now() / 1000);
    const b = await provider.getBlock("latest");
    return Number(b.timestamp);
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
            <strong>Owned NFTs:</strong> {ownedTokenIds.length ? ownedTokenIds.map((id) => `${tokenDisplayName(chainId, NFT_ADDRESS, id)}`).join(", ") : "None"}
          </div>
          <div className="mt-3">
          </div>
        </Card.Body>
      </Card>

      <Card className="mb-4">
        <Card.Header className="d-flex justify-content-between align-items-center">
          <strong>Available Loan Requests</strong>
          <Button onClick={loadAll}>Refresh</Button>
        </Card.Header>
        <Card.Body>
          <Table bordered hover responsive>
            <thead>
              <tr>
                <th>Request ID</th>
                <th>Borrower</th>
                <th>Amount (ETH)</th>
                <th>Duration</th>
                <th>Interest</th>
                <th>Collateral tokenId</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.requestId}>
                  <td>{r.requestId}</td>
                  <td>{r.borrower}</td>
                  <td>{r.loanAmount}</td>
                  <td>{r.duration} days</td>
                  <td>{r.interestRate}%</td>
                  <td>{r.collateralTokenId ? tokenDisplayName(chainId, NFT_ADDRESS, r.collateralTokenId) : "N/A"}</td>
                  <td>
                    {r.isActive ? <Badge bg="success">PENDING</Badge> : <Badge bg="secondary">INACTIVE</Badge>}
                  </td>
                  <td>
                    {r.isActive ? (
                      <Button size="sm" onClick={() => fund(r)}>Fund</Button>
                    ) : (
                      "-"
                    )}
                  </td>
                </tr>
              ))}
              {requests.length === 0 && (
                <tr><td colSpan={8} className="text-center">No active requests</td></tr>
              )}
            </tbody>
          </Table>
        </Card.Body>
      </Card>

      <Card>
        <Card.Header className="d-flex justify-content-between align-items-center">
          <strong>Active Loans</strong>
          <Button onClick={loadAll}>Refresh</Button>
        </Card.Header>
        <Card.Body>
          <Table bordered hover responsive>
            <thead>
              <tr>
                <th>Loan ID</th>
                <th>Borrower</th>
                <th>Lender</th>
                <th>Amount (ETH)</th>
                <th>Interest</th>
                <th>Collateral tokenId</th>
                <th>End Time</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {activeLoans.map((l) => (
                <LoanRow key={l.loanId} loan={l} onLiquidate={liquidate} nowTs={nowTs} chainId={chainId} />
              ))}
              {activeLoans.length === 0 && (
                <tr><td colSpan={8} className="text-center">No active loans</td></tr>
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
        style={{ position: "fixed", top: 20, right: 20, minWidth: 320, zIndex: 9999 }}
      >
        <Toast.Header closeButton={true}>
          <strong className="me-auto">Notification</strong>
        </Toast.Header>
        <Toast.Body className={toast.variant === "danger" ? "text-danger" : ""}>
          {toast.message}
        </Toast.Body>
      </Toast>
    </Container>
  );
};

function LoanRow({ loan, onLiquidate, nowTs, chainId }) {
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    (async () => {
      const t = await nowTs();
      setExpired(t > loan.endTime);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loan.endTime]);

  return (
    <tr>
      <td>{loan.loanId}</td>
      <td>{loan.borrower}</td>
      <td>{loan.lender}</td>
      <td>{loan.loanAmount}</td>
      <td>{loan.interestRate}%</td>
      <td>{loan.collateralTokenId ? tokenDisplayName(chainId, NFT_ADDRESS, loan.collateralTokenId) : "N/A"}</td>
      <td>{new Date(loan.endTime * 1000).toLocaleString()}</td>
      <td>
        {expired ? (
          <Button variant="danger" size="sm" onClick={() => onLiquidate(loan.loanId)}>
            Liquidate
          </Button>
        ) : (
          <Badge bg="info">Running</Badge>
        )}
      </td>
    </tr>
  );
}

export default Lender;
