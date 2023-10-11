import { parseUnits } from 'viem';
import { arbitrumGoerli } from 'viem/chains';
import {
  Taker,
  ClearinghouseContract,
  Option,
  ERC20Contract,
  SeaportContract,
} from './entities/index.js';
import { rfqClient } from './lib/grpc.js';
import {
  SEAPORT_ADDRESS,
  USDC_ADDRESS,
  WETH_ADDRESS,
} from './lib/constants.js';
import {
  ParsedQuoteResponse,
  parseQuoteResponse,
  getTimestamps,
} from './utils/index.js';

/**
 * Setup & Configuration
 */

// replace with your own account to use for signing
// you will need a Valorem Access Pass
const PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

// create a Taker instance (essentially a wallet/account/signer, with some utility methods)
const taker = new Taker({
  privateKey: PRIVATE_KEY,
  chain: arbitrumGoerli,
});

// create a client object to pass to contracts
const clients = {
  publicClient: taker.publicClient,
  walletClient: taker.walletClient,
};

// create contract instances
const clearinghouse = new ClearinghouseContract(clients);
const seaport = new SeaportContract(clients);
const usdc = new ERC20Contract({
  ...clients,
  address: USDC_ADDRESS,
});

/**
 * Main Taker Logic
 * - Authenticate with Valorem Trade API
 * - Initialize an option with Valorem Clearinghouse
 * - Send RFQs to Market Makers
 * - Accept returned quotes by executing the signed offers on Seaport
 */

// 1. Authenticate with Valorem Trade API
async function authenticate() {
  await taker.signIn();
  if (!taker.authenticated) {
    throw new Error('Sign in failed.');
  }
}

// 2. Initialize an option with Valorem Clearinghouse
async function createOption() {
  // Configure your own option type here!
  const underlyingAsset = WETH_ADDRESS;
  const exerciseAsset = USDC_ADDRESS;
  const underlyingAmount = parseUnits('1', 18); // 1 WETH, 18 decimals
  const exerciseAmount = parseUnits('2000', 6); // 2k USDC, 6 decimals
  const { exerciseTimestamp, expiryTimestamp } = getTimestamps(); // 1 week window

  const option = new Option({
    underlyingAsset,
    underlyingAmount,
    exerciseAsset,
    exerciseAmount,
    exerciseTimestamp,
    expiryTimestamp,
  });

  // check if option type already exists
  const optionExists = await option.optionTypeExists(clearinghouse);
  if (!optionExists) {
    // if it does not exist, create it
    await option.createOptionType(taker, clearinghouse);
  } else {
    console.log('Option type already created.');
  }

  return option;
}

// 3. Send RFQs
async function sendRfqRequests(optionId: bigint) {
  // Create your own quote request logic here!
  // for this example: a quote request to buy 5 options
  const quoteRequest = taker.createQuoteRequest({
    optionId,
    quantityToBuy: 5,
  });

  const quoteRequestStream = async function* () {
    yield quoteRequest;
  };

  // continuously send requests and handle responses
  console.log('Sending RFQs for option ID', optionId.toString());
  while (true) {
    for await (const quoteResponse of rfqClient.taker(quoteRequestStream())) {
      if (Object.keys(quoteResponse).length === 0) {
        console.log('Received an empty quote response...');
        continue;
      }

      // parse the response
      const parsedQuoteResponse = parseQuoteResponse(quoteResponse);

      // create your own quote response handling logic here
      // ie: check that the price is within a certain range, add to a queue and accept the best offer after a delay, etc
      // for this example: accept all quotes
      console.log('Received a valid quote response!');
      acceptReturnedQuote(parsedQuoteResponse);
    }
  }
}

// 4. Execute the signed offers on Seaport
async function acceptReturnedQuote(quote: ParsedQuoteResponse) {
  /** Check balances and allowances needed to accept quote */
  const usdcPremium = quote.order.parameters.consideration[0]!.startAmount;

  const hasEnoughBalance = await taker.hasEnoughERC20Balance({
    erc20: usdc,
    amount: usdcPremium,
  });
  if (!hasEnoughBalance) {
    console.log(
      `Not enough balance to accept quote. Need ${parseUnits(
        usdcPremium.toString(),
        usdc.decimals
      )} USDC.`
    );
    return;
  }

  const hasEnoughAllowance = await taker.hasEnoughERC20Allowance({
    erc20: usdc,
    amount: usdcPremium,
    spender: SEAPORT_ADDRESS,
  });
  if (!hasEnoughAllowance) {
    await taker.approveERC20({
      erc20: usdc,
      spender: SEAPORT_ADDRESS,
      amount: usdcPremium,
    });
  }

  /** Accept quote by executing fulfillOrder on Seaport */
  await taker.acceptQuote({ quote, seaport });
}

async function main() {
  await authenticate();
  const option = await createOption();
  await sendRfqRequests(option.id);
}

main();
