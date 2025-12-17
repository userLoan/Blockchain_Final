import React from "react";
import { NoWalletDetected } from "./NoWalletDetected";
import { ConnectWallet } from "./ConnectWallet";
import BorrowerInterface from "./Borrower";
import LenderInterface from "./Lender";

import { Container, Card, Button, Alert, Nav, Navbar } from "react-bootstrap";

const HARDHAT_CHAIN_ID_DEC = 31337;
const HARDHAT_CHAIN_ID_HEX = "0x7a69"; // 31337

export class Dapp extends React.Component {
  constructor(props) {
    super(props);

    this.initialState = {
      selectedAddress: undefined,
      userRole: undefined,
      networkError: undefined,
    };

    this.state = this.initialState;

    // bind
    this._connectWallet = this._connectWallet.bind(this);
    this._dismissNetworkError = this._dismissNetworkError.bind(this);
    this._resetState = this._resetState.bind(this);
    this._initialize = this._initialize.bind(this);
    this._checkNetwork = this._checkNetwork.bind(this);
    this._switchChain = this._switchChain.bind(this);
    this._addHardhatChain = this._addHardhatChain.bind(this);

    this._handleAccountsChanged = this._handleAccountsChanged.bind(this);
    this._handleChainChanged = this._handleChainChanged.bind(this);
  }

  componentDidMount() {
    if (window.ethereum) {
      // Attach listeners once
      window.ethereum.on("accountsChanged", this._handleAccountsChanged);
      window.ethereum.on("chainChanged", this._handleChainChanged);
    }
  }

  componentWillUnmount() {
    if (window.ethereum?.removeListener) {
      window.ethereum.removeListener(
        "accountsChanged",
        this._handleAccountsChanged
      );
      window.ethereum.removeListener("chainChanged", this._handleChainChanged);
    }
  }

  _handleAccountsChanged(accs) {
    const newAddress = Array.isArray(accs) ? accs[0] : undefined;

    if (!newAddress) {
      this._resetState();
      return;
    }

    // Reset role to avoid showing old role UI with a new account
    this.setState({ userRole: undefined });
    this._initialize(newAddress);
  }

  _handleChainChanged() {
    // When chain changes, safest is to reset UI state
    this.setState({
      selectedAddress: undefined,
      userRole: undefined,
      networkError: undefined,
    });
  }

  render() {
    if (window.ethereum === undefined) {
      return <NoWalletDetected />;
    }

    if (!this.state.selectedAddress) {
      return (
        <ConnectWallet
          connectWallet={this._connectWallet}
          networkError={this.state.networkError}
          dismiss={this._dismissNetworkError}
        />
      );
    }

    const { selectedAddress, userRole } = this.state;

    return (
      <div className="dapp-wrapper">
        <Navbar bg="dark" variant="dark" expand="lg">
          <Container>
            <Navbar.Brand>DLoan Platform</Navbar.Brand>
            <Navbar.Toggle aria-controls="basic-navbar-nav" />
            <Navbar.Collapse>
              <Nav className="me-auto">
                <Nav.Link onClick={() => this.setState({ userRole: undefined })}>
                  Home
                </Nav.Link>
              </Nav>
              <Navbar.Text>
                Signed in as: <span>{selectedAddress}</span>
              </Navbar.Text>
            </Navbar.Collapse>
          </Container>
        </Navbar>

        <Container className="mt-4">
          {!userRole ? (
            <Card className="text-center">
              <Card.Header as="h5">Welcome to DLoan</Card.Header>
              <Card.Body>
                <Card.Title>Choose Your Role</Card.Title>
                <Card.Text>
                  Select your role to get started with our decentralized loan
                  platform.
                </Card.Text>
                <Button
                  variant="primary"
                  className="me-2"
                  onClick={() => this.setState({ userRole: "borrower" })}
                >
                  I'm a Borrower
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => this.setState({ userRole: "lender" })}
                >
                  I'm a Lender
                </Button>
              </Card.Body>
            </Card>
          ) : (
            <>
              <Alert variant="info">
                You are logged in as: <strong>{userRole}</strong>
              </Alert>

              {userRole === "borrower" && <BorrowerInterface />}
              {userRole === "lender" && <LenderInterface />}
            </>
          )}
        </Container>
      </div>
    );
  }

  async _connectWallet() {
    try {
      await this._checkNetwork();

      const accounts = await window.ethereum.request({
        method: "eth_requestAccounts",
      });

      const selectedAddress = Array.isArray(accounts)
        ? accounts[0]
        : undefined;

      if (!selectedAddress) {
        this.setState({ networkError: "No account returned from wallet" });
        return;
      }

      this._initialize(selectedAddress);
    } catch (err) {
      console.error(err);

      // User rejected / chain switch rejected
      const msg =
        err?.message ||
        "Failed to connect wallet or switch to Hardhat network";

      this.setState({ networkError: msg });
    }
  }

  _initialize(userAddress) {
    this.setState({
      selectedAddress: userAddress,
    });
  }

  _dismissNetworkError() {
    this.setState({ networkError: undefined });
  }

  _resetState() {
    this.setState(this.initialState);
  }

  async _checkNetwork() {
    if (!window.ethereum) return;

    // Prefer eth_chainId
    const chainId = await window.ethereum.request({ method: "eth_chainId" });

    // chainId is hex string like "0x7a69"
    if (chainId?.toLowerCase() !== HARDHAT_CHAIN_ID_HEX) {
      await this._switchChain();
    }
  }

  async _switchChain() {
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: HARDHAT_CHAIN_ID_HEX }],
      });
    } catch (switchError) {
      // 4902 = unknown chain in MetaMask
      if (switchError?.code === 4902) {
        await this._addHardhatChain();
        return;
      }
      throw switchError;
    }
  }

  async _addHardhatChain() {
    // Add local Hardhat network config
    await window.ethereum.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: HARDHAT_CHAIN_ID_HEX,
          chainName: "Hardhat Local",
          nativeCurrency: {
            name: "ETH",
            symbol: "ETH",
            decimals: 18,
          },
          rpcUrls: ["http://127.0.0.1:8545"],
        },
      ],
    });
  }
}
