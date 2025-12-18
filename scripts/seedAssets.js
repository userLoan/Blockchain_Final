import { network } from "hardhat";

async function main() {
  const { ethers } = await network.connect();

  // Lấy địa chỉ TokenNFT từ file frontend (deploy.js đã ghi ra)
  const addrBook = await import("../frontend/src/contracts/contract-address.json", { assert: { type: "json" } });
  const nftAddr = addrBook.default.TokenNFT;

  const nft = await ethers.getContractAt("TokenNFT", nftAddr);

  const assets = [
    [0, "Gold - 1oz bar"],
    [1, "Silver - 1kg bar"],
    [2, "Car"],
    [3, "Motorbike"],
    [4, "House"],
    [5, "Land plot"],
    [6, "Watch"],
    [7, "Jewelry"],
    [8, "National ID"],
    [9, "Laptop"],
  ];

  for (const [t, name] of assets) {
    const tx = await nft.mint(t, name);
    await tx.wait();
    console.log(`Minted: type=${t} name="${name}"`);
  }

  console.log("Done seeding 10 assets.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
