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

const toNum = (v) => {
  const n = Number((v ?? "").toString().trim());
  return Number.isFinite(n) ? n : 0;
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

const Borrower = () => {
  const [account, setAccount] = useState("");
  const [ethBalance, setEthBalance] = useState("");
  const [nftCount, setNftCount] = useState(0);
  const [ownedTokenIds, setOwnedTokenIds] = useState([]);

  const [lendingContract, setLendingContract] = useState(null);
  const [nftContract, setNftContract] = useState(null);

  const [myRequests, setMyRequests] = useState([]);
  const [myActiveLoans, setMyActiveLoans] = useState([]);

  const [autoExpireBusy, setAutoExpireBusy] = useState(false);

  const [formData, setFormData] = useState({
    amount: "",
    interestRate: "",
    duration: "",
    tokenId: "",
  });

  const amountEth = toNum(formData.amount);
  const ratePct = toNum(formData.interestRate);

  const interestEth = amountEth * (ratePct / 100);
  const totalRepayEth = amountEth + interestEth;

  const [toast, setToast] = useState({ show: false, message: "", variant: "success" });
  const showToast = (message, variant = "success") => setToast({ show: true, message, variant });

  const provider = useMemo(() => {
    if (!window.ethereum) return null;
    return new ethers.providers.Web3Provider(window.ethereum);
  }, []);

  useEffect(() => {
    const init = async () => {
      if (!provider) return;

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
    setNftCount(c.toNumber());

    const ids = await getOwnedTokenIds(nftContract, account);
    setOwnedTokenIds(ids);

    setFormData((prev) => {
      const current = (prev.tokenId ?? "").toString().trim();
      const currentNum = Number(current);
      const ownsCurrent = current && ids.some((x) => Number(x) === currentNum);
      if (ownsCurrent) return prev;
      if (ids.length === 0) return { ...prev, tokenId: "" };
      return { ...prev, tokenId: String(ids[0]) };
    });
  };

  const loadMyData = async () => {
    if (!lendingContract || !account) return;

    // Chain time
    let chainNow = Math.floor(Date.now() / 1000);
    try {
      const latestBlock = await provider.getBlock("latest");
      if (latestBlock?.timestamp) chainNow = latestBlock.timestamp;
    } catch {}

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
        duration: (r.durationInDays ? r.durationInDays.toNumber() : r.duration.toNumber()),
        interestRate: r.interestRate.toNumber(),
        isActive: r.isActive,
        collateralTokenId: r.collateralTokenId.toNumber(),
        statusCode,
        createdAt,
        expiresAt,
        expiredByTime,
      };
    });

    setMyRequests(mappedReq);

    // Auto-expire: nếu quá 2 ngày mà vẫn ACTIVE -> tự gọi expireLoanRequest để trả NFT
    if (!autoExpireBusy) {
      const target = mappedReq.find((x) => x.isActive && x.statusCode === STATUS.ACTIVE && x.expiredByTime);
      if (target) {
        try {
          setAutoExpireBusy(true);
          const tx = await lendingContract.expireLoanRequest(target.requestId);
          await tx.wait();
          showToast(`Request #${target.requestId} was not funded in 2 days. NFT returned to you.`, "success");
        } catch (e) {
          console.error(e);
          showToast(extractRevertReason(e), "danger");
        } finally {
          setAutoExpireBusy(false);
        }
      }
    }

    // Active loans (filter by borrower)
    const all = await lendingContract.getAllActive();
    const loanIds = all[0];
    const loans = all[1];

    const mappedLoans = loans
      .map((l, i) => ({
        loanId: loanIds[i].toNumber(),
        borrower: l.borrower,
        lender: l.lender,
        loanAmount: ethers.utils.formatEther(l.loanAmount),
        endTime: l.endTime.toNumber(),
        isExpired: chainNow > l.endTime.toNumber(),
        interestRate: l.interestRate.toNumber(),
        collateralTokenId: l.collateralTokenId.toNumber(),
      }))
      .filter((x) => x.borrower.toLowerCase() === account.toLowerCase());

    setMyActiveLoans(mappedLoans);
  };

  useEffect(() => {
    if (!account || !lendingContract || !nftContract) return;
    (async () => {
      await updateBalances();
      await loadMyData();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, lendingContract, nftContract]);

  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setFormData((p) => ({ ...p, [name]: value }));
  };

  const mintNft = async () => {
    if (!nftContract) return;
    try {
      const tx = await nftContract.mint();
      await tx.wait();
      await updateBalances();
      showToast("Minted a new NFT successfully", "success");
    } catch (e) {
      console.error(e);
      showToast(extractRevertReason(e), "danger");
    }
  };

  const createLoanRequest = async (e) => {
    e.preventDefault();
    if (!lendingContract || !nftContract) return;

    try {
      const amountWei = ethers.utils.parseEther(formData.amount || "0");
      const duration = ethers.BigNumber.from(formData.duration || "0");
      const interest = ethers.BigNumber.from(formData.interestRate || "0");
      const tokenId = parseInt(formData.tokenId || "0", 10);

      if (amountWei.lte(0)) return showToast("Loan amount must be > 0", "warning");
      if (duration.lte(0)) return showToast("Duration must be > 0", "warning");
      if (interest.lte(0)) return showToast("Interest rate must be > 0", "warning");
      if (!tokenId || tokenId <= 0) return showToast("Please enter a valid NFT tokenId", "warning");

      const owner = await nftContract.ownerOf(tokenId);
      if (owner.toLowerCase() !== account.toLowerCase()) {
        return showToast(`You do not own this NFT tokenId. Owned: ${ownedTokenIds.join(", ") || "-"}`, "danger");
      }

      const approved = await nftContract.getApproved(tokenId);
      const isAll = await nftContract.isApprovedForAll(account, LENDING_ADDRESS);
      if (!isAll && approved.toLowerCase() !== LENDING_ADDRESS.toLowerCase()) {
        const approveTx = await nftContract.approve(LENDING_ADDRESS, tokenId);
        await approveTx.wait();
      }

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
    // Borrower requirement: nếu không fund trong 2 ngày => "KHÔNG FUND"
    if ((r.statusCode === STATUS.ACTIVE && r.expiredByTime) || r.statusCode === STATUS.EXPIRED) {
      return <Badge bg="warning" text="dark">UNFUNDED</Badge>;
    }
    if (r.statusCode === STATUS.ACTIVE) return <Badge bg="success">ACTIVE</Badge>;
    if (r.statusCode === STATUS.FUNDED) return <Badge bg="info">FUNDED</Badge>;
    if (r.statusCode === STATUS.CANCELLED) return <Badge bg="secondary">CANCELLED</Badge>;
    return <Badge bg="secondary">UNKNOWN</Badge>;
  };

  const renderReqAction = (r) => {
    if (r.statusCode === STATUS.ACTIVE && r.expiredByTime) {
      return (
        <Button variant="outline-warning" size="sm" disabled={autoExpireBusy} onClick={() => manualExpire(r.requestId)}>
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

  return (
    <Container className="py-4">
      <Card className="mb-4">
        <Card.Header><strong>Borrower Dashboard</strong></Card.Header>
        <Card.Body>
          <div><strong>Account:</strong> {account}</div>
          <div className="mt-2"><strong>ETH Balance:</strong> {ethBalance} ETH</div>
          <div className="mt-2"><strong>NFT Balance:</strong> {nftCount} TokenNFT</div>
          <div className="mt-2">
            <strong>Owned tokenIds:</strong> {ownedTokenIds.length ? ownedTokenIds.join(", ") : "None"}
          </div>
          <div className="mt-3">
            <Button variant="secondary" onClick={mintNft}>Mint NFT</Button>{" "}
          </div>
        </Card.Body>
      </Card>

      <Card className="mb-4">
        <Card.Header><strong>Create Loan Request</strong></Card.Header>
        <Card.Body>
          <Form onSubmit={createLoanRequest}>
            <Form.Group as={Row} className="mb-3">
              <Form.Label column sm={3}>Amount (ETH)</Form.Label>
              <Col sm={9}>
                <Form.Control
                  name="amount"
                  value={formData.amount}
                  onChange={handleInputChange}
                  placeholder="Enter loan amount in ETH"
                />
              </Col>
            </Form.Group>

            <Form.Group as={Row} className="mb-3">
              <Form.Label column sm={3}>Interest Rate (%)</Form.Label>
              <Col sm={9}>
                <Form.Control
                  name="interestRate"
                  value={formData.interestRate}
                  onChange={handleInputChange}
                  placeholder="Enter interest rate (max 7)"
                />
                <div className="text-muted mt-1" style={{ fontSize: 13 }}>
                  Maximum interest rate allowed is {7}%
                </div>
                <div div className="text-muted mt-1" style={{ fontSize: 13 }}>
                  Interest: {interestEth > 0 ? interestEth.toFixed(6) : "0"} ETH
                </div>
                <div div className="text-muted mt-1" style={{ fontSize: 13 }}>
                  Total to repay: {totalRepayEth > 0 ? totalRepayEth.toFixed(6) : "0"} ETH
                </div>
              </Col>
            </Form.Group>

            <Form.Group as={Row} className="mb-3">
              <Form.Label column sm={3}>Duration (days)</Form.Label>
              <Col sm={9}>
                <Form.Control
                  name="duration"
                  value={formData.duration}
                  onChange={handleInputChange}
                  placeholder="Enter duration in days"
                />
              </Col>
            </Form.Group>

            <Form.Group as={Row} className="mb-3">
              <Form.Label column sm={3}>Collateral (NFT tokenId)</Form.Label>
              <Col sm={9}>
                {ownedTokenIds.length > 0 ? (
                  <>
                    <Form.Select
                      name="tokenId"
                      value={formData.tokenId}
                      onChange={handleInputChange}
                    >
                      {ownedTokenIds.map((id) => (
                        <option key={id} value={id}>
                          {id}
                        </option>
                      ))}
                    </Form.Select>
                    <Form.Text muted>
                      Select a tokenId you own. Owned tokenIds: {ownedTokenIds.join(", ")}
                    </Form.Text>
                  </>
                ) : (
                  <>
                    <Form.Control
                      type="number"
                      name="tokenId"
                      placeholder="Mint or enter a tokenId you own"
                      value={formData.tokenId}
                      onChange={handleInputChange}
                    />
                    <Form.Text muted>
                      The NFT will be escrowed in the contract until you repay (or liquidated on expiry).
                    </Form.Text>
                  </>
                )}
              </Col>
            </Form.Group>

            <Button type="submit">Create Loan</Button>
          </Form>
        </Card.Body>
      </Card>

      <Card className="mb-4">
        <Card.Header className="d-flex justify-content-between align-items-center">
          <strong>Your Requests</strong>
          <Button variant="outline-primary" size="sm" onClick={loadMyData}>
            Refresh
          </Button>
        </Card.Header>
        <Card.Body>
          <Table bordered hover responsive>
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
              {myRequests.map((r) => (
                <tr key={r.requestId}>
                  <td>{r.requestId}</td>
                  <td>{r.loanAmount}</td>
                  <td>{r.duration}</td>
                  <td>{r.interestRate}%</td>
                  <td>{r.collateralTokenId || "N/A"}</td>
                  <td>{renderReqStatus(r)}</td>
                  <td>{renderReqAction(r)}</td>
                </tr>
              ))}
              {myRequests.length === 0 && (
                <tr><td colSpan={7} className="text-center">No requests</td></tr>
              )}
            </tbody>
          </Table>
        </Card.Body>
      </Card>

      <Card>
        <Card.Header className="d-flex justify-content-between align-items-center">
          <strong>Your Active Loans</strong>
        </Card.Header>
        <Card.Body>
          <Table bordered hover responsive>
            <thead>
              <tr>
                <th>Loan ID</th>
                <th>Amount (ETH)</th>
                <th>Interest</th>
                <th>Collateral tokenId</th>
                <th>End Time</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {myActiveLoans.map((l) => (
                <tr key={l.loanId}>
                  <td>{l.loanId}</td>
                  <td>{l.loanAmount}</td>
                  <td>{l.interestRate}%</td>
                  <td>{l.collateralTokenId}</td>
                  <td>{new Date(l.endTime * 1000).toLocaleString()}</td>
                  <td>
                    {l.isExpired ? (
                      <Badge bg="danger">EXPIRED</Badge>
                    ) : (
                      <Button size="sm" onClick={() => repayLoan(l.loanId)}>Repay</Button>
                    )}
                  </td>
                </tr>
              ))}
              {myActiveLoans.length === 0 && (
                <tr><td colSpan={6} className="text-center">No active loans</td></tr>
              )}
            </tbody>
          </Table>
        </Card.Body>
      </Card>

      <Toast
        show={toast.show}
        onClose={() => setToast((p) => ({ ...p, show: false }))}
        delay={3000}
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

export default Borrower;
