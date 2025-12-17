// scripts/deploy.js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { network } from "hardhat";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const { ethers } = await network.connect();

  // Hardhat default signers:
  // signer[0] = 0xf39...
  // signer[1] = 0x7099...
  // signer[2] = 0x3C44...
  const signers = await ethers.getSigners();

  const deployer = signers[0];
  const borrower = signers[0]; // borrower = 0xf39...
  const lender   = signers[1]; // lender   = 0x7099...

  console.log("Deploying with (deployer):", deployer.address);
  console.log("Borrower:", borrower.address);
  console.log("Lender  :", lender.address);

  const bal = await ethers.provider.getBalance(deployer.address);
  console.log("Balance:", ethers.formatEther(bal), "ETH");

  // 1) Deploy TokenNFT (ERC-721)
  const TokenNFT = await ethers.getContractFactory("TokenNFT");
  const tokenNft = await TokenNFT.connect(deployer).deploy();
  await tokenNft.waitForDeployment();
  const tokenNftAddress = await tokenNft.getAddress();
  console.log("TokenNFT deployed:", tokenNftAddress);

  // 2) Deploy LendingPlatform
  const LendingPlatform = await ethers.getContractFactory("LendingPlatform");
  const lending = await LendingPlatform.connect(deployer).deploy(tokenNftAddress);
  await lending.waitForDeployment();
  const lendingAddress = await lending.getAddress();
  console.log("LendingPlatform deployed:", lendingAddress);

  // 3) Mint demo NFTs
  // Assumes TokenNFT.mint() mints to msg.sender
  await (await tokenNft.connect(borrower).mint()).wait();
  await (await tokenNft.connect(borrower).mint()).wait();
  console.log("Minted 2 NFTs to borrower:", borrower.address);

  await (await tokenNft.connect(lender).mint()).wait();
  console.log("Minted 1 NFT to lender:", lender.address);

  // 4) Write addresses + ABIs for frontend
  const contractsDir = path.join(__dirname, "..", "frontend", "src", "contracts");
  if (!fs.existsSync(contractsDir)) fs.mkdirSync(contractsDir, { recursive: true });

  fs.writeFileSync(
    path.join(contractsDir, "contract-address.json"),
    JSON.stringify(
      {
        LendingPlatform: lendingAddress,
        TokenNFT: tokenNftAddress,
      },
      null,
      2
    )
  );

  const contractNames = ["LendingPlatform", "TokenNFT"];
  for (const name of contractNames) {
    const factory = await ethers.getContractFactory(name);
    const abiJson = factory.interface.formatJson();
    fs.writeFileSync(path.join(contractsDir, `${name}.abi.json`), abiJson);
  }

  console.log("Frontend contract files written to:", contractsDir);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
