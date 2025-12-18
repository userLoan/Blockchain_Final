import React, { useEffect, useMemo, useState } from "react";
import { Container, Row, Col, Form, Button, Table, Card, Badge, Toast } from "react-bootstrap";
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

const toNum = (v) => {
  const n = Number((v ?? "").toString().trim());
  return Number.isFinite(n) ? n : 0;
};

const Borrower = () => {
  const [account, setAccount] = useState("");
  const [ethBalance, setEthBalance] = useState("");
  const [nftCount, setNftCount] = useState(0);

  const [ownedTokenIds, setOwnedTokenIds] = useState([]);
  const [ownedTokenMeta, setOwnedTokenMeta] = useState([]); // [{id,type,name}]

  const [lendingContract, setLendingContract] = useState(null);
  const [nftContract, setNftContract] = useState(null);

  const [myRequests, setMyRequests] = useState([]);
  const [myActiveLoans, setMyActiveLoans] = useState([]);

  const [autoExpireBusy, setAutoExpireBusy] = useState(false);

  const [toast, setToast] = useState({ show: false, message: "", variant: "success" });
  const showToast = (message, variant = "success") => setToast({ show: true, message, variant });

  // Mint form (optional demo metadata)
  const [mintForm, setMintForm] = useState({ assetType: "0", assetName: "" });

  // Create loan request form
  const [formData, setFormData] = useState({
    amount: "",
    interestRate: "",
    duration: "",
    tokenId: "",
  });

  const amountEth = toNum(formData.amount);
  const ratePct = toNum(formData.interestRate);
  const interestEth = amountEth > 0 && ratePct > 0 ? (amountEth * ratePct) / 100 : 0;
  const totalRepayEth = amountEth > 0 ? amountEth + interestEth : 0;

  const provider = useMemo(() => {
    if (!window.ethereum) return null;
    return new ethers.providers.Web3Provider(window.ethereum);
  }, []);

  useEffect(() => {
    const init = async () => {
      if (!provider) return;

      // Ensure wallet connected
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

  const tryGetAssetMeta = async (tokenId) => {
    // Works if TokenNFT has assetNameOf/assetTypeOf; otherwise fallback.
    let name = `Token ${tokenId}`;
    let type = 0;
    if (!nftContract) return { id: Number(tokenId), type, name };

    try {
      if (nftContract.assetNameOf) name = await nftContract.assetNameOf(tokenId);
    } catch (_) {}
    try {
      if (nftContract.assetTypeOf) type = (await nftContract.assetTypeOf(tokenId)).toNumber();
    } catch (_) {}

    return { id: Number(tokenId), type, name };
  };

  const updateBalances = async () => {
    if (!provider || !nftContract || !account) return;

    const bal = await provider.getBalance(account);
    setEthBalance(ethers.utils.formatEther(bal));

    const c = await nftContract.balanceOf(account);
    setNftCount(c.toNumber());

    const ids = await getOwnedTokenIds(nftContract, account);
    setOwnedTokenIds(ids);

    // enrich meta
    const meta = await Promise.all(ids.map((id) => tryGetAssetMeta(id)));
    setOwnedTokenMeta(meta);

    // keep tokenId in form valid
    setFormData((prev) => {
      const current = (prev.tokenId ?? "").toString().trim();
      const currentNum = Number(current);
      const ownsCurrent = current && ids.some((x) => Number(x) === currentNum);
      if (ownsCurrent) return prev;
      if (ids.length === 0) return { ...prev, tokenId: "" };
      return { ...prev, tokenId: String(ids[0]) };
    });
  };

  const loadMyData = async (skipAuto = false) => {
    if (!lendingContract || !account) return;

    const chainNow = await nowTs();

    // Borrower requests
    const res = await lendingContract.getBorrowerRequests(account);
    const requestIds = res[0];
    const requests = res[1];

    const expiry = await lendingContract.REQUEST_EXPIRY();
    const createdArr = await Promise.all(requestIds.map((id) => lendingContract.requestCreatedAt(id)));
    const statusArr = await Promise.all(requestIds.map((id) => lendingContract.requestStatus(id)));

    const mappedReq = requests.map((r, i) => {
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
        isActive: r.isActive,
        collateralTokenId: r.collateralTokenId.toNumber(),
        statusCode,
        createdAt,
        expiresAt,
        expiredByTime,
      };
    });

    // Active loans (filter by borrower)
    const allActive = await lendingContract.getAllActive();
    const loanIds = allActive[0];
    const loans = allActive[1];

    const mappedLoans = loans
      .map((l, i) => ({
        loanId: loanIds[i].toNumber(),
        borrower: l.borrower,
        lender: l.lender,
        loanAmountWei: l.loanAmount,
        loanAmount: ethers.utils.formatEther(l.loanAmount),
        endTime: l.endTime.toNumber(),
        interestRate: l.interestRate.toNumber(),
        collateralTokenId: l.collateralTokenId.toNumber(),
      }))
      .filter((x) => x.borrower?.toLowerCase() === account.toLowerCase());

    setMyRequests(mappedReq);
    setMyActiveLoans(mappedLoans);

    // Auto-expire: if ACTIVE + expiredByTime => call expireLoanRequest to return NFT
    if (!skipAuto && !autoExpireBusy) {
      const target = mappedReq.find((x) => x.isActive && x.statusCode === STATUS.ACTIVE && x.expiredByTime);
      if (target) {
        setAutoExpireBusy(true);
        try {
          const tx = await lendingContract.expireLoanRequest(target.requestId);
          await tx.wait();
          showToast(`Request #${target.requestId} was not funded in 2 days. NFT returned to you.`, "success");
        } catch (e) {
          // If user rejects / revert, keep UI stable; manual button still exists.
          console.error(e);
          showToast(extractRevertReason(e), "danger");
        } finally {
          setAutoExpireBusy(false);
        }

        await updateBalances();
        await loadMyData(true); // refresh UI after finalizing expiry
        return;
      }
    }
  };

  useEffect(() => {
    if (!account || !lendingContract || !nftContract) return;
    (async () => {
      await updateBalances();
      await loadMyData();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, lendingContract, nftContract]);

  const mintNft = async () => {
    if (!nftContract) return;
    try {
      // Try mint(assetType, assetName) first; fallback to mint()
      let tx;
      try {
        tx = await nftContract.mint(Number(mintForm.assetType), mintForm.assetName || "");
      } catch (_) {
        tx = await nftContract.mint();
      }
      await tx.wait();
      showToast("Minted a new NFT successfully", "success");
      await updateBalances();
      await loadMyData();
    } catch (e) {
      console.error(e);
      showToast(extractRevertReason(e), "danger");
    }
  };

  const createRequest = async () => {
    if (!lendingContract || !nftContract) return;

    try {
      const amountEthNum = toNum(formData.amount);
      const duration = toNum(formData.duration);
      const interest = toNum(formData.interestRate);
      const tokenId = toNum(formData.tokenId);

      if (amountEthNum <= 0) return showToast("Amount must be > 0", "danger");
      if (duration <= 0) return showToast("Duration must be > 0", "danger");
      if (interest <= 0 || interest > 7) return showToast("Interest rate must be 1..7", "danger");
      if (!tokenId) return showToast("Select a collateral tokenId", "danger");

      // Ownership check
      const owner = await nftContract.ownerOf(tokenId);
      if (owner.toLowerCase() !== account.toLowerCase()) {
        return showToast(`You do not own this NFT tokenId. Owned: ${ownedTokenIds.join(", ") || "-"}`, "danger");
      }

      // Ensure approval
      const approved = await nftContract.getApproved(tokenId);
      const isAll = await nftContract.isApprovedForAll(account, LENDING_ADDRESS);
      if (!isAll && approved.toLowerCase() !== LENDING_ADDRESS.toLowerCase()) {
        const approveTx = await nftContract.approve(LENDING_ADDRESS, tokenId);
        await approveTx.wait();
      }

      const amountWei = ethers.utils.parseEther(String(amountEthNum));
      const tx = await lendingContract.createLoanRequest(amountWei, duration, interest, tokenId);
      await tx.wait();

      showToast("Loan request created successfully (NFT escrowed).", "success");
      setFormData((p) => ({ ...p, amount: "" }));

      await updateBalances();
      await loadMyData();
    } catch (e2) {
      console.error(e2);
      showToast(extractRevertReason(e2), "danger");
    }
  };

  const cancelRequest = async (requestId) => {
    if (!lendingContract) return;
    try {
      const tx = await lendingContract.cancelLoanRequest(requestId);
      await tx.wait();
      showToast("Request cancelled. NFT returned to you.", "success");
      await updateBalances();
      await loadMyData();
    } catch (e) {
      console.error(e);
      showToast(extractRevertReason(e), "danger");
    }
  };

  const manualExpire = async (requestId) => {
    if (!lendingContract) return;
    try {
      const tx = await lendingContract.expireLoanRequest(requestId);
      await tx.wait();
      showToast("Request not funded in 2 days. NFT returned to you.", "success");
      await updateBalances();
      await loadMyData();
    } catch (e) {
      console.error(e);
      showToast(extractRevertReason(e), "danger");
    }
  };

  const repayLoan = async (loanId) => {
    if (!lendingContract) return;
    try {
      const required = await lendingContract.getRepayAmount(loanId);
      const tx = await lendingContract.repayLoan(loanId, { value: required });
      await tx.wait();
      showToast("Loan repaid successfully. NFT returned to you.", "success");
      await updateBalances();
      await loadMyData();
    } catch (e) {
      console.error(e);
      showToast(extractRevertReason(e), "danger");
    }
  };

  const renderReqStatus = (r) => {
    // Borrower requirement: nếu không fund trong 2 ngày => "UNFUNDED"
    if ((r.statusCode === STATUS.ACTIVE && r.expiredByTime) || r.statusCode === STATUS.EXPIRED) {
      return (
        <Badge bg="warning" text="dark">
          UNFUNDED
        </Badge>
      );
    }
    if (r.statusCode === STATUS.ACTIVE) return <Badge bg="success">ACTIVE</Badge>;
    if (r.statusCode === STATUS.FUNDED) return <Badge bg="info">FUNDED</Badge>;
    if (r.statusCode === STATUS.CANCELLED) return <Badge bg="secondary">CANCELLED</Badge>;
    return <Badge bg="secondary">UNKNOWN</Badge>;
  };

  const renderReqAction = (r) => {
    // If expiredByTime, UI will auto-trigger; keep manual fallback button
    if (r.statusCode === STATUS.ACTIVE && r.expiredByTime) {
      return (
        <Button
          variant="outline-warning"
          size="sm"
          disabled={autoExpireBusy}
          onClick={() => manualExpire(r.requestId)}
        >
          Return NFT
        </Button>
      );
    }
    if (r.statusCode === STATUS.ACTIVE && !r.expiredByTime) {
      return (
        <Button variant="danger" size="sm" onClick={() => cancelRequest(r.requestId)}>
          Cancel
        </Button>
      );
    }
    return "-";
  };

  const renderTokenLabel = (tokenId) => {
    const m = ownedTokenMeta.find((x) => Number(x.id) === Number(tokenId));
    if (m) return `${tokenId} - ${m.name}`;
    return String(tokenId);
  };

  return (
    <Container className="py-4">
      <Card className="mb-4">
        <Card.Header>
          <strong>Borrower Dashboard</strong>
        </Card.Header>
        <Card.Body>
          <div><strong>Account:</strong> {account}</div>
          <div className="mt-2"><strong>ETH Balance:</strong> {ethBalance} ETH</div>
          <div className="mt-2"><strong>NFT Balance:</strong> {nftCount} TokenNFT</div>

          <div className="mt-2">
            <strong>Owned tokenIds:</strong>{" "}
            {ownedTokenMeta.length ? ownedTokenIds.map((id) => `Token ${id}`).join(", ") : "None"}
          </div>

          <Row className="mt-3">
            <Col md={4}>
              <Form.Select
                className="mb-2"
                value={mintForm.assetType}
                onChange={(e) => setMintForm((p) => ({ ...p, assetType: e.target.value }))}
              >
                <option value="0">Gold</option>
                <option value="1">Silver</option>
                <option value="2">Car</option>
                <option value="3">Motorbike</option>
                <option value="4">House</option>
                <option value="5">Land plot</option>
                <option value="6">Watch</option>
                <option value="7">Jewelry</option>
                <option value="8">National ID</option>
                <option value="9">Other</option>
              </Form.Select>
            </Col>
            <Col md={5}>
              <Form.Control
                className="mb-2"
                placeholder='e.g., "Gold - 1oz bar"'
                value={mintForm.assetName}
                onChange={(e) => setMintForm((p) => ({ ...p, assetName: e.target.value }))}
              />
            </Col>
            <Col md={3}>
              <Button variant="secondary" onClick={mintNft} className="w-100">
                Mint NFT
              </Button>
            </Col>
          </Row>
        </Card.Body>
      </Card>

      <Card className="mb-4">
        <Card.Header><strong>Create Loan Request</strong></Card.Header>
        <Card.Body>
          <Row className="mb-3">
            <Col md={4}><Form.Label>Amount (ETH)</Form.Label></Col>
            <Col md={8}>
              <Form.Control
                placeholder="Enter loan amount in ETH"
                value={formData.amount}
                onChange={(e) => setFormData((p) => ({ ...p, amount: e.target.value }))}
              />
            </Col>
          </Row>

          <Row className="mb-3">
            <Col md={4}><Form.Label>Interest Rate (%)</Form.Label></Col>
            <Col md={8}>
              <Form.Control
                placeholder="Enter interest rate (max 7)"
                value={formData.interestRate}
                onChange={(e) => setFormData((p) => ({ ...p, interestRate: e.target.value }))}
              />
              <div className="text-muted mt-1" style={{ fontSize: 13 }}>
                Maximum interest rate allowed is {7}%
              </div>
              <div className="text-muted mt-1" style={{ fontSize: 13 }}>
                Interest: {interestEth > 0 ? interestEth.toFixed(6) : "0"} ETH
              </div>
              <div className="text-muted" style={{ fontSize: 13 }}>
                Total to repay: {totalRepayEth > 0 ? totalRepayEth.toFixed(6) : "0"} ETH
              </div>
            </Col>
          </Row>

          <Row className="mb-3">
            <Col md={4}><Form.Label>Duration (days)</Form.Label></Col>
            <Col md={8}>
              <Form.Control
                placeholder="Enter duration in days"
                value={formData.duration}
                onChange={(e) => setFormData((p) => ({ ...p, duration: e.target.value }))}
              />
            </Col>
          </Row>

          <Row className="mb-3">
            <Col md={4}><Form.Label>Collateral (NFT tokenId)</Form.Label></Col>
            <Col md={8}>
              <Form.Select
                value={formData.tokenId}
                onChange={(e) => setFormData((p) => ({ ...p, tokenId: e.target.value }))}
              >
                {ownedTokenMeta.length === 0 ? (
                  <option value="">No NFTs owned</option>
                ) : (
                  ownedTokenMeta.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))
                )}
              </Form.Select>
              <div className="text-muted mt-1" style={{ fontSize: 13 }}>
                Select a tokenId you own. Owned tokenIds: {ownedTokenIds.length ? ownedTokenIds.join(", ") : "None"}
              </div>
            </Col>
          </Row>

          <Button onClick={createRequest}>Create Loan</Button>
        </Card.Body>
      </Card>

      <Card className="mb-4">
        <Card.Header><strong>Your Requests</strong></Card.Header>
        <Card.Body>
          <Button variant="outline-primary" size="sm" className="mb-2" onClick={loadMyData}>
            Refresh
          </Button>

          <Table bordered hover>
            <thead>
              <tr>
                <th>Request ID</th>
                <th>Amount (ETH)</th>
                <th>Duration (days)</th>
                <th>Interest</th>
                <th>Collateral tokenId</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {myRequests.length === 0 ? (
                <tr><td colSpan="7">No requests yet.</td></tr>
              ) : (
                myRequests.map((r) => (
                  <tr key={r.requestId}>
                    <td>{r.requestId}</td>
                    <td>{r.loanAmount}</td>
                    <td>{r.duration}</td>
                    <td>{r.interestRate}%</td>
                    <td>{renderTokenLabel(r.collateralTokenId)}</td>
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
        <Card.Header><strong>Your Active Loans</strong></Card.Header>
        <Card.Body>
          <Button variant="outline-primary" size="sm" className="mb-2" onClick={loadMyData}>
            Refresh
          </Button>

          <Table bordered hover>
            <thead>
              <tr>
                <th>Loan ID</th>
                <th>Lender</th>
                <th>Amount (ETH)</th>
                <th>Interest</th>
                <th>End Time</th>
                <th>Collateral tokenId</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {myActiveLoans.length === 0 ? (
                <tr><td colSpan="7">No active loans.</td></tr>
              ) : (
                myActiveLoans.map((l) => (
                  <tr key={l.loanId}>
                    <td>{l.loanId}</td>
                    <td>{l.lender}</td>
                    <td>{l.loanAmount}</td>
                    <td>{l.interestRate}%</td>
                    <td>{new Date(l.endTime * 1000).toLocaleString()}</td>
                    <td>{renderTokenLabel(l.collateralTokenId)}</td>
                    <td>
                      <Button size="sm" variant="success" onClick={() => repayLoan(l.loanId)}>
                        Repay
                      </Button>
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

export default Borrower;
