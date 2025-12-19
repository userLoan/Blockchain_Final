// frontend/src/components/Borrower.js
import React, { useEffect, useMemo, useState } from "react";
import { Container, Row, Col, Form, Button, Table, Card, Badge, Toast } from "react-bootstrap";
import { ethers } from "ethers";

import LendingPlatformABI from "../contracts/LendingPlatform.abi.json";
import TokenNFTABI from "../contracts/TokenNFT.abi.json";
import addresses from "../contracts/contract-address.json";

// Support both deploy output styles
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
// We KEEP mint() unchanged. Custom names are stored in browser localStorage.
// If you need names on-chain (portable across devices), we must add a mintWithName() in the NFT contract.
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// Default mapping (you can edit freely)
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

function saveTokenName(chainId, nftAddress, tokenId, name) {
  if (!nftAddress || tokenId == null) return;
  const trimmed = String(name || "").trim();
  if (!trimmed) return;

  const key = storageKey(chainId, nftAddress);
  const map = loadNameMap(chainId, nftAddress);
  map[String(tokenId)] = trimmed;
  window.localStorage.setItem(key, JSON.stringify(map));
}

function tokenDisplayName(chainId, nftAddress, tokenId) {
  const id = Number(tokenId);
  const map = loadNameMap(chainId, nftAddress);
  return map[String(tokenId)] || DEFAULT_ASSET_BY_TOKEN_ID[id] || `Token ${id}`;
}

function extractRevertReason(err) {
  const data = err?.error?.data || err?.data || err?.error?.error?.data;
  const msg = err?.error?.message || err?.message || "";

  // Ethers v5: "execution reverted: <reason>"
  const m1 = msg.match(/reverted(?: with reason string)?(?::| )['"]?([^'"]+)['"]?/i);
  if (m1?.[1]) return m1[1];

  // Ethers v5: sometimes nested body JSON
  try {
    const body = err?.error?.body;
    if (typeof body === "string") {
      const j = JSON.parse(body);
      const m2 = j?.error?.message?.match(/reverted(?: with reason string)?(?::| )['"]?([^'"]+)['"]?/i);
      if (m2?.[1]) return m2[1];
    }
  } catch (_) {}

  // Try to decode Error(string)
  if (data && typeof data === "string" && data.startsWith("0x08c379a0")) {
    try {
      const reason = ethers.utils.defaultAbiCoder.decode(["string"], "0x" + data.slice(10))[0];
      if (reason) return reason;
    } catch (_) {}
  }

  return msg || "Transaction failed";
}

async function getOwnedTokenIds(nft, owner) {
  // Demo approach: scan tokenIds from 1..nextTokenId-1 and collect those owned by `owner`
  const owned = [];
  let nextId = 1;
  try {
    nextId = toInt(await nft.nextTokenId());
  } catch (_) {
    // fallback
    nextId = 1;
  }
  for (let id = 1; id < nextId; id++) {
    try {
      const o = await nft.ownerOf(id);
      if (o && o.toLowerCase() === owner.toLowerCase()) owned.push(id);
    } catch (_) {
      // tokenId may not exist
    }
  }
  return owned;
}

const toNum = (v, fallback = 0) => {
  if (v === null || v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const fmtEth = (n) => {
  if (!Number.isFinite(n)) return "0";
  // hiển thị gọn: 0, 1.2, 20, 20.123456
  return n.toLocaleString(undefined, { maximumFractionDigits: 6 });
};

const Borrower = () => {
  const [account, setAccount] = useState("");
  const [ethBalance, setEthBalance] = useState("");
  const [nftCount, setNftCount] = useState(0);
  const [ownedTokenIds, setOwnedTokenIds] = useState([]);

  const [chainId, setChainId] = useState(null);
  const [mintName, setMintName] = useState("");
  const [nameVersion, setNameVersion] = useState(0);

  const [lendingContract, setLendingContract] = useState(null);
  const [nftContract, setNftContract] = useState(null);

  const [myRequests, setMyRequests] = useState([]);
  const [myActiveLoans, setMyActiveLoans] = useState([]);

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

    // If user hasn't selected a tokenId yet (or selected one they don't own),
    // default to the first owned tokenId to avoid accidental reverts.
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

    // Borrower requests
    const res = await lendingContract.getBorrowerRequests(account);
    const requestIds = tuple(res, 'requestIds', 0, []);
    const requests = tuple(res, 'requests', 1, []);

    const mappedReq = (requests || [])
      .map((r, i) => {
        const rid = (requestIds || [])[i];
        if (!rid || !r) return null;
        return {
          requestId: toInt(rid),
          borrower: r.borrower,
          loanAmount: ethers.utils.formatEther(r.loanAmount),
          duration: toInt(r.duration),
          interestRate: toInt(r.interestRate),
          isActive: r.isActive,
          collateralTokenId: toInt(r.collateralTokenId),
        };
      })
      .filter(Boolean);
    setMyRequests(mappedReq);

    // Active loans: scan all active loans and filter by borrower (demo)
    // Chain time (IMPORTANT): Hardhat time travel only affects block.timestamp.
    // So we use latest block timestamp to decide whether a loan is expired.
    let chainNow = Math.floor(Date.now() / 1000);
    try {
      const latestBlock = await provider.getBlock("latest");
      if (latestBlock?.timestamp) chainNow = latestBlock.timestamp;
    } catch (e) {
      // fallback to local time
    }

    const all = await lendingContract.getAllActive();
    const loanIds = tuple(all, 'loanIds', 0, []);
    const loans = tuple(all, 'loans', 1, []);

    const mappedLoans = (loans || [])
      .map((l, i) => {
        const lid = (loanIds || [])[i];
        if (!lid || !l) return null;
        const end = toInt(l.endTime);
        return {
          loanId: toInt(lid),
          borrower: l.borrower,
          lender: l.lender,
          loanAmount: ethers.utils.formatEther(l.loanAmount),
          endTime: end,
          isExpired: chainNow > end,
          chainNow,
          interestRate: toInt(l.interestRate),
          collateralTokenId: toInt(l.collateralTokenId),
        };
      })
      .filter(Boolean)
      .filter((x) => (x?.borrower || "").toLowerCase() === account.toLowerCase());

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
      const tx = await nftContract.mint(); // KEEP the mint() flow unchanged
      const receipt = await tx.wait();

      // Try to extract tokenId from the ERC721 Transfer(0x0 -> account) event
      let mintedTokenId = null;
      try {
        const ev = receipt?.events?.find(
          (e) =>
            e?.event === "Transfer" &&
            e?.args &&
            String(e.args.from).toLowerCase() === ZERO_ADDRESS &&
            String(e.args.to).toLowerCase() === String(account).toLowerCase()
        );
        mintedTokenId = ev?.args?.tokenId != null ? ev.args.tokenId.toString() : null;
      } catch (_) {}

      // Fallback if event seen is missing (some providers omit decoded events)
      if (mintedTokenId == null) {
        try {
          const next = await nftContract.nextTokenId();
          mintedTokenId = next.sub(1).toString();
        } catch (_) {}
      }

      // Save custom name (UI-only) if user entered it
      const custom = (mintName || "").trim();
      if (custom && mintedTokenId != null) {
        saveTokenName(chainId, NFT_ADDRESS, mintedTokenId, custom);
        setMintName("");
        setNameVersion((v) => v + 1);
      }

      await updateBalances();
      showToast(
        mintedTokenId ? `Minted NFT #${mintedTokenId}${custom ? ` (${custom})` : ""} successfully` : "Minted a new NFT successfully",
        "success"
      );
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

      // UI check: must own tokenId
      const owner = await nftContract.ownerOf(tokenId);
      if (owner.toLowerCase() !== account.toLowerCase()) {
        return showToast(`You do not own this NFT tokenId. Owned: ${ownedTokenIds.join(", ") || "-"}`, "danger");
      }

      // Approve platform for this tokenId if needed
      const approved = await nftContract.getApproved(tokenId);
      const isAll = await nftContract.isApprovedForAll(account, LENDING_ADDRESS);
      if (!isAll && approved.toLowerCase() !== LENDING_ADDRESS.toLowerCase()) {
        const approveTx = await nftContract.approve(LENDING_ADDRESS, tokenId);
        await approveTx.wait();
      }

      const tx = await lendingContract.createLoanRequest(amountWei, duration, interest, tokenId);
      await tx.wait();

      showToast("Loan request created successfully", "success");
      setFormData((p) => ({ ...p, amount: "", tokenId: "" }));
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

  return (
    <Container className="py-4">
      <Card className="mb-4">
        <Card.Header><strong>Borrower Dashboard</strong></Card.Header>
        <Card.Body>
          <div><strong>Account:</strong> {account}</div>
          <div className="mt-2"><strong>ETH Balance:</strong> {ethBalance} ETH</div>
          <div className="mt-2"><strong>NFT Balance:</strong> {nftCount} TokenNFT</div>
          <div className="mt-2">
            <strong>Owned NFTs:</strong> {ownedTokenIds.length ? ownedTokenIds.map((id) => `${tokenDisplayName(chainId, NFT_ADDRESS, id)}`).join(", ") : "None"}
          </div>
          <div className="mt-3">
            <Form.Group className="mb-2">
              <Form.Label>NFT name (optional)</Form.Label>
              <Form.Control
                type="text"
                placeholder='e.g., "Gold", "House", "Car"'
                value={mintName}
                onChange={(e) => setMintName(e.target.value)}
              />
            </Form.Group>
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
                <div className="text-muted mt-1" style={{ fontSize: 13 }}>
                  Interest: {fmtEth(interestEth)} ETH
                </div>

                <div className="text-muted mt-1" style={{ fontSize: 13 }}>
                  Total to repay: {fmtEth(totalRepayEth)} ETH
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
              <Form.Label column sm={3}>Collateral (NFT)</Form.Label>
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
                          {tokenDisplayName(chainId, NFT_ADDRESS, id)}
                        </option>
                      ))}
                    </Form.Select>

                    <Form.Text muted>
                      Owned NFTs:{" "}
                      {ownedTokenIds
                        .map((id) => `${tokenDisplayName(chainId, NFT_ADDRESS, id)}`)
                        .join(", ")}
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
        </Card.Header>
        <Card.Body>
          <Table bordered hover responsive>
            <thead>
              <tr>
                <th>Request ID</th>
                <th>Amount (ETH)</th>
                <th>Duration (days)</th>
                <th>Interest</th>
                <th>Collateral</th>
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
                  <td>{r.collateralTokenId ? tokenDisplayName(chainId, NFT_ADDRESS, r.collateralTokenId) : "N/A"}</td>
                  <td>
                    {r.isActive ? <Badge bg="success">ACTIVE</Badge> : <Badge bg="secondary">INACTIVE</Badge>}
                  </td>
                  <td>
                    {r.isActive ? (
                      <Button variant="danger" size="sm" onClick={() => cancelRequest(r.requestId)}>
                        Cancel
                      </Button>
                    ) : (
                      "-"
                    )}
                  </td>
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
                <th>Collateral</th>
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
                  <td>{l.collateralTokenId ? tokenDisplayName(chainId, NFT_ADDRESS, l.collateralTokenId) : "N/A"}</td>
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
