import React from "react";
import { NetworkErrorMessage } from "./NetworkErrorMessage";
import heroImg from "./Logo/logo.jpeg";
import "./ConnectWallet.css";

export function ConnectWallet({ connectWallet, networkError, dismiss }) {
  return (
    <div
      className="connect-hero"
      style={{ backgroundImage: `url(${heroImg})` }}
    >
      <div className="connect-hero__overlay" />

      <div className="container connect-hero__container">
        <div className="row">
          <div className="col-12">
            {networkError && (
              <div className="connect-hero__error">
                <NetworkErrorMessage message={networkError} dismiss={dismiss} />
              </div>
            )}
          </div>
        </div>

        <div className="row align-items-center" style={{ minHeight: "72vh" }}>
          <div className="col-12 col-lg-6">
            <h1 className="connect-hero__title">
              Decentralized P2P Lending — Powered by Blockchain
            </h1>

            <p className="connect-hero__subtitle">
              Borrow ETH using your NFT as collateral, or fund requests to earn interest —
              all enforced by smart contracts.
            </p>

            <ul className="connect-hero__bullets">
              <li><strong>NFT-collateralized loans:</strong> collateral is escrowed on-chain</li>
              <li><strong>Transparent terms:</strong> amount, duration, and interest are enforced by the contract</li>
              <li><strong>Time-bound requests:</strong> if unfunded within 2 days, collateral is returned on expiry</li>
            </ul>

            <button className="btn btn-primary btn-lg connect-hero__cta" type="button" onClick={connectWallet}>
              Connect wallet to start
            </button>

            <div className="connect-hero__hint">
              Connect your wallet to access Borrower and Lender dashboards.
            </div>
          
          </div>
        </div>
      </div>
    </div>
  );
}
