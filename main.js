import { JsonRpcProvider, Wallet, parseUnits } from "ethers";
import * as dotenv from "dotenv";
dotenv.config();

const RPC_URL = process.env.RPC_URL ?? "https://carrot.megaeth.com/rpc";
const PRIVATE_KEYS_STRING = process.env.PRIVATE_KEYS; // Comma-separated list of private keys
const CHAIN_ID = 6342; // Mega Test-net
const TARGET = "0xbe43d66327ca5b77e7f14870a94a3058511103d3";
const CALL_DATA = "0x05632f40";
const TOTAL_TX = 500; // Keep it low for testing the new logic
const MAX_FEE_GWEI = "0.009"; // well above min 0.0025; stays cheap on test-net
const LOG_INTERVAL = 10; // Log after every transaction for detailed feedback with small TOTAL_TX
const GAS_LIMIT = 90000; // Standard gas limit, adjust if needed
const RETRY_DELAY_MS = 1000; // 5 seconds delay for retries on "txpool is full"
const MAX_TRANSACTION_RETRIES = 5; // Max retries for a single transaction
const INTER_TRANSACTION_DELAY_MS = 10; // Delay within each wallet's transaction sending loop
const INTER_WALLET_START_DELAY_MS = 5; // Optional: stagger start of wallets slightly

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function processWalletTransactions(wallet, numTransactionsToSend, initialBaseNonce, walletId, provider) {
  console.log(`Wallet ${walletId} (${wallet.address}) starting with nonce ${initialBaseNonce} for ${numTransactionsToSend} transactions.`);
  let successfulTxForWallet = 0;
  let failedTxForWallet = 0;
  let currentNonce = initialBaseNonce;

  for (let i = 0; i < numTransactionsToSend; i++) {
    const logicalTxNumber = i + 1;
    let attempt = 0;
    let transactionSent = false;

    while (attempt < MAX_TRANSACTION_RETRIES && !transactionSent) {
      attempt++;
      try {
        const tx = {
          to: TARGET,
          value: 0,
          gasLimit: GAS_LIMIT,
          maxFeePerGas: parseUnits(MAX_FEE_GWEI, "gwei"),
          maxPriorityFeePerGas: parseUnits(MAX_FEE_GWEI, "gwei"), // Assuming same for simplicity, adjust if needed
          nonce: currentNonce,
          chainId: CHAIN_ID,
          data: CALL_DATA,
        };

        // console.log(`Wallet ${walletId}: Attempt ${attempt}/${MAX_TRANSACTION_RETRIES} for logical tx ${logicalTxNumber}/${numTransactionsToSend} with nonce ${currentNonce}.`);
        const signedTx = await wallet.signTransaction(tx);
        const txResponse = await provider.broadcastTransaction(signedTx);
        // const txResponse = await wallet.sendTransaction(tx); // Using provider.broadcastTransaction for potentially better control or if wallet.sendTransaction has issues with rapid fire.
        
        console.log(`Wallet ${walletId}: Transaction ${logicalTxNumber} (nonce ${currentNonce}) sent. Hash: ${txResponse.hash}`);
        successfulTxForWallet++;
        currentNonce++; // Increment nonce for next transaction *for this wallet*
        transactionSent = true;

        if (INTER_TRANSACTION_DELAY_MS > 0) {
          await delay(INTER_TRANSACTION_DELAY_MS);
        }

      } catch (error) {
        console.error(`Wallet ${walletId}: Error on attempt ${attempt} for logical tx ${logicalTxNumber} (nonce ${currentNonce}): ${error.message}`);
        if (error.code === 'NONCE_EXPIRED' || error.message.includes('nonce too low') || error.message.includes('already known')) {
          console.log(`Wallet ${walletId}: Nonce error detected. Fetching new nonce for wallet ${wallet.address}...`);
          const newNonceFromProvider = await provider.getTransactionCount(wallet.address, "pending");
          console.log(`Wallet ${walletId}: Old nonce: ${currentNonce}, New nonce from provider: ${newNonceFromProvider}. Adjusting.`);
          currentNonce = newNonceFromProvider; // Update to the latest nonce from provider
          // Do not increment attempt count here, let loop retry with new nonce
        } else if (error.message.includes('txpool is full')) {
          console.log(`Wallet ${walletId}: TxPool is full. Waiting ${RETRY_DELAY_MS}ms before retrying transaction with nonce ${currentNonce}...`);
          await delay(RETRY_DELAY_MS);
          // Retry with the same nonce, don't increment attempt yet, or handle as per strategy
        } else {
          // For other errors, break or count as a failed attempt
          if (attempt >= MAX_TRANSACTION_RETRIES) {
            console.error(`Wallet ${walletId}: Max retries reached for logical tx ${logicalTxNumber}. Transaction failed.`);
            failedTxForWallet++;
          }
        }
      }
    } // End while retries
    if (!transactionSent) {
      // This case should be rare if MAX_TRANSACTION_RETRIES is handled inside, but as a fallback
      console.error(`Wallet ${walletId}: Transaction ${logicalTxNumber} ultimately failed after all retries.`);
      failedTxForWallet++;
      // Decide how to handle nonce for next tx if this one failed. For now, we assume it might be stuck, try to get fresh.
      currentNonce = await provider.getTransactionCount(wallet.address, "pending");
    }
  } // End for loop (numTransactionsToSend)

  console.log(`Wallet ${walletId} (${wallet.address}) finished. Successful: ${successfulTxForWallet}, Failed: ${failedTxForWallet}`);
  return { walletId, address: wallet.address, successful: successfulTxForWallet, failed: failedTxForWallet };
}

async function main() {
  if (!PRIVATE_KEYS_STRING) throw new Error("Set PRIVATE_KEYS (comma-separated) in .env");
  const privateKeys = PRIVATE_KEYS_STRING.split(',').map(pk => pk.trim()).filter(pk => pk !== '');
  if (privateKeys.length === 0) throw new Error("No private keys found in PRIVATE_KEYS .env variable.");

  console.log(`Found ${privateKeys.length} private keys.`);

  const provider = new JsonRpcProvider(RPC_URL, CHAIN_ID, { batchMaxCount: 1 });
  const wallets = privateKeys.map((pk, index) => {
    try {
      return new Wallet(pk, provider);
    } catch (e) {
      console.error(`Error creating wallet for key at index ${index}: ${e.message}. Ensure it's a valid private key.`);
      return null;
    }
  }).filter(w => w !== null);

  if (wallets.length === 0) {
    console.error("No valid wallets could be created from the provided private keys.");
    return;
  }
  console.log(`Successfully created ${wallets.length} wallets.`);
  if (wallets.length !== privateKeys.length) {
    console.warn("Some private keys were invalid and wallets could not be created for them.");
  }

  const numWallets = wallets.length;
  const promises = [];
  let totalOverallSuccess = 0;
  let totalOverallFailed = 0;

  console.time("totalExecutionTime");

  // Step 1: Fetch all initial nonces in parallel
  console.log("Fetching initial nonces for all wallets in parallel...");
  const noncePromises = wallets.map(wallet => 
    provider.getTransactionCount(wallet.address, "pending")
      .catch(err => { // Add error handling for individual nonce fetches
        console.error(`Failed to fetch nonce for wallet ${wallet.address}: ${err.message}. This wallet will be skipped.`);
        return -1; // Indicator of failure, so Promise.all doesn't reject outright
      })
  );
  const initialNoncesUnfiltered = await Promise.all(noncePromises);
  console.log("All initial nonce fetch attempts completed.");

  // Filter out wallets for which nonce fetching failed and prepare data for processing
  const walletProcessingData = [];
  for (let i = 0; i < numWallets; i++) {
    if (initialNoncesUnfiltered[i] === -1) { // Check for failure indicator
      // Error already logged in the catch block above
      continue;
    }
    walletProcessingData.push({
      wallet: wallets[i],
      initialNonce: initialNoncesUnfiltered[i],
      walletIdOriginalIndex: i // Keep original index for logging
    });
  }
  
  // Recalculate transactions per wallet based on successfully prepared wallets
  const numProcessableWallets = walletProcessingData.length;
  if (numProcessableWallets === 0 && TOTAL_TX > 0) {
    console.error("No wallets could be prepared for transaction processing (e.g., all nonce fetches failed or no wallets initially). Halting.");
    console.timeEnd("totalExecutionTime");
    return;
  }
  
  // Initialize transaction distribution variables only if there are processable wallets
  let transactionsPerWalletBase = 0;
  let remainingTransactions = 0;

  if (numProcessableWallets > 0) {
    transactionsPerWalletBase = Math.floor(TOTAL_TX / numProcessableWallets);
    remainingTransactions = TOTAL_TX % numProcessableWallets;
    console.log(`Distributing ${TOTAL_TX} transactions across ${numProcessableWallets} processable wallets.`);
    console.log(`Base transactions per wallet: ${transactionsPerWalletBase}`);
    if (remainingTransactions > 0) {
      console.log(`${remainingTransactions} wallets will handle one extra transaction.`);
    }
  } else if (TOTAL_TX > 0) {
    // This case means TOTAL_TX > 0 but no wallets to process them.
    console.warn(`There are ${TOTAL_TX} transactions to send but no wallets are available for processing.`);
  } else {
    // TOTAL_TX is 0 or less, no transactions to send.
    console.log("No transactions targeted (TOTAL_TX is 0 or less).");
  }

  // Step 2: Prepare and push transaction processing promises
  for (let i = 0; i < numProcessableWallets; i++) {
    const { wallet: currentWallet, initialNonce, walletIdOriginalIndex } = walletProcessingData[i];
    
    console.log(`Wallet index ${walletIdOriginalIndex} (${currentWallet.address}) using pre-fetched initial nonce: ${initialNonce}`);
    
    let txForThisWallet = transactionsPerWalletBase + (remainingTransactions > 0 ? 1 : 0);
    if (remainingTransactions > 0) remainingTransactions--;

    // If, after distribution, a wallet gets 0 tx but TOTAL_TX was > 0, log and skip.
    // This is mainly a safeguard; with proper distribution, it should only happen if TOTAL_TX < numProcessableWallets.
    if (txForThisWallet === 0 && TOTAL_TX > 0) {
        console.log(`Wallet index ${walletIdOriginalIndex} (${currentWallet.address}) has no transactions assigned (txForThisWallet is 0), skipping.`);
        continue;
    }

    // The cumulative INTER_WALLET_START_DELAY_MS * i block has been removed
    // to allow "at once" dispatching of the initial transactions.

    promises.push(processWalletTransactions(currentWallet, txForThisWallet, initialNonce, walletIdOriginalIndex, provider));
  }

  if (promises.length > 0) {
    console.log(`\nStarting transaction processing for all ${promises.length} active wallets...\n`);
    const results = await Promise.allSettled(promises);

    console.log("\n-----------------------------------------");
    console.log("         Overall Wallet Summary          ");
    console.log("-----------------------------------------");
    results.forEach(result => {
      if (result.status === 'fulfilled' && result.value) {
        const { walletId, address, successful, failed } = result.value;
        console.log(`Wallet ${walletId} (${address}): Successful: ${successful}, Failed: ${failed}`);
        totalOverallSuccess += successful;
        totalOverallFailed += failed;
      } else {
        // Log reason for promise rejection or if value is undefined
        console.error(`A wallet's transaction processing promise failed or returned unexpected data: ${result.reason || 'No value returned'}`);
        // Here, you might want to estimate failures if a wallet's entire processing failed.
        // This requires knowing how many Txs it was assigned. For now, this is a general error.
      }
    });
  } else {
    console.log("No transactions were assigned to any wallets (e.g., TOTAL_TX might be 0 or less than active wallets).");
  }
  
  console.timeEnd("totalExecutionTime");
  console.log("-----------------------------------------");
  console.log("        Final Transaction Summary        ");
  console.log("-----------------------------------------");
  console.log(`Total logical transactions targeted:  ${TOTAL_TX}`);
  console.log(`Total successfully sent transactions: ${totalOverallSuccess}`);
  console.log(`Total failed transactions:            ${totalOverallFailed}`);
  console.log("-----------------------------------------");
}

main().catch(console.error);