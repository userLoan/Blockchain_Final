
# DApp with Hardhat, React, EthersJS, and Solidity

A decentralized application for Loan management with smart contract development.

## Initial Setup

Install Hardhat and required dependencies !Important:

```bash
npm install --legacy-peer-deps
```

## Local Network Setup

Start the local Hardhat network:

```bash
npx hardhat node
```

Deploy your contracts (in a new terminal):

```bash
npx hardhat run scripts/deploy.js --network localhost
```

## Network Configuration

### Add Local Network to MetaMask

1. Open MetaMask settings, security
2. Scroll down and click "Add Custom Network"
3. Enter network details:
    - **Network Name:** Hardhat
    - **New RPC URL:** http://127.0.0.1:8545
    - **Chain ID:** 31337
    - **Currency Symbol:** ETH

4. **Important:** If you encounter "Transaction failed" errors, reboot the browser, remove and re-add the network in MetaMask or "clear activity tab data" and then re-run "npm start"

### Import Test Accounts

1. Copy the private keys provided by Hardhat node when started locally.
2. In MetaMask, click on the account icon.
3. Select "Import Account".
4. Paste the private key (copied from console) and confirm.

## Testing and Development

Access Hardhat console for contract testing:

```bash
npx hardhat console --network localhost
```

Testing:

```bash
npx hardhat test
```

## Frontend Init

Navigate to frontend directory and install dependencies:

```bash
cd frontend
npm install
npm start
```

Access DApp at `http://localhost:3000`.

## Requirements

- MetaMask browser extension
- Node.js and npm installed
- Web browser

## Additional Resources

For more detailed information about Hardhat integration with React, EthersJS, and MetaMask, refer to the [official Hardhat documentation](https://hardhat.org).
