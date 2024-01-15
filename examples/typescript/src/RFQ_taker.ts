import { createPublicClient, createWalletClient, http, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrumSepolia } from 'viem/chains';
import {
  ERC20Contract,
  ParsedQuoteResponse,
  SEAPORT_ADDRESS,
  ValoremSDK,
  OptionType,
  get24HrTimestamps,
  GRPC_ENDPOINT,
  trackCookieInterceptor,
  Auth,
  RFQ,
  SupportedAsset,
} from '@valorem-labs-inc/sdk';
import { createPromiseClient } from '@connectrpc/connect';
import { createGrpcTransport } from '@connectrpc/connect-node';

/** Viem Config */

// replace with your own account to use for signing
// you will need a Valorem Access Pass
const PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const account = privateKeyToAccount(PRIVATE_KEY);

const publicClient = createPublicClient({
  chain: arbitrumSepolia,
  transport: http(),
});
const walletClient = createWalletClient({
  account,
  chain: arbitrumSepolia,
  transport: http(),
});

/** GRPC Config */
const transport = createGrpcTransport({
  baseUrl: GRPC_ENDPOINT,
  httpVersion: '2',
  interceptors: [trackCookieInterceptor],
  nodeOptions: {
    rejectUnauthorized: false,
  },
});

const authClient = createPromiseClient(Auth, transport);
const rfqClient = createPromiseClient(RFQ, transport);

/** Init Valorem SDK with clients */
const valoremSDK = new ValoremSDK({
  publicClient,
  walletClient,
  authClient,
  rfqClient,
});

// get the WebTaker instance (essentially a wallet/account/signer, with some utility methods)
const webTaker = valoremSDK.webTaker;

// Our mock tokens on Arbitrum Sepolia
const USDC = SupportedAsset.fromSymbolAndChainId('USDC', 421614);
const WETH = SupportedAsset.fromSymbolAndChainId('WETH', 421614);

// contract instances
const clearinghouse = valoremSDK.clearinghouse;
const usdc = new ERC20Contract({
  address: USDC.address,
  publicClient,
  walletClient,
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
  await webTaker.signIn();
  if (!webTaker.authenticated) {
    throw new Error('Sign in failed.');
  }
}

// 2. Initialize an option with Valorem Clearinghouse
async function createOptionType() {
  // Configure your own option type here!
  const underlyingAsset = WETH.address;
  const exerciseAsset = USDC.address;
  const underlyingAmount = 1000000000000n; // 1 WETH, divided by 1e6
  const exerciseAmount = 2500n; // 2500 USDC, divided by 1e6
  const { exerciseTimestamp, expiryTimestamp } = get24HrTimestamps();

  const optionInfo = {
    underlyingAsset,
    underlyingAmount,
    exerciseAsset,
    exerciseAmount,
    exerciseTimestamp,
    expiryTimestamp,
  };

  const optionType = await OptionType.fromInfo({
    optionInfo,
    clearinghouse,
  });

  // check if option type already exists
  if (!optionType.typeExists) {
    // if it does not exist, create it
    await optionType.createOptionType(webTaker);
  } else {
    console.log('Option type already created.');
  }

  if (!optionType.optionTypeId) throw new Error('Failed to get OptionTypeId');
  return optionType.optionTypeId;
}

// 3. Send RFQs
async function sendRfqRequests(optionId: bigint) {
  // Create your own quote request logic here!
  // for this example: a quote request to buy 1000 options
  const quoteRequest = webTaker.createQuoteRequest({
    optionId,
    quantityToBuy: 1,
  });

  // quote streams can accept an abort signal to close the stream
  // for this example we will close it after a successful quote response
  const abortController = new AbortController();
  const abort = () => {
    console.log('Closing stream...');
    abortController.abort();
  };

  // this is the callback that will be called when a quote response is received
  const onQuoteResponse = async (quote: ParsedQuoteResponse) => {
    abort(); // close the stream

    // create your own quote response handling logic here
    // ie: check that the price is within a certain range, add to a queue and accept the best offer after a delay, etc
    // for this example we will make sure we have enough balance and allowance to accept the quote
    const sufficient = await checkBalanceAndAllowance(quote);

    if (sufficient) {
      console.log('Accepting quote...');
      await webTaker.acceptQuote({ quote });
      console.log('Done!');
    } else {
      console.log('Not enough balance or allowance to accept quote.');
    }
  };

  // continuously send requests and handle responses
  await webTaker.sendRFQ({
    quoteRequest,
    onQuoteResponse,
    signal: abortController.signal,
  });
}

/** Check balances and allowances needed to accept quote */
async function checkBalanceAndAllowance(
  quote: ParsedQuoteResponse
): Promise<boolean> {
  const usdcPremium = quote.order.parameters.consideration[0]!.startAmount;

  const hasEnoughBalance = await webTaker.hasEnoughERC20Balance({
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
    return false;
  }

  const hasEnoughAllowance = await webTaker.hasEnoughERC20Allowance({
    erc20: usdc,
    amount: usdcPremium,
    spender: SEAPORT_ADDRESS,
  });
  if (!hasEnoughAllowance) {
    await webTaker.approveERC20({
      tokenAddress: usdc.address,
      spender: SEAPORT_ADDRESS,
      amount: usdcPremium,
    });
  }

  return true;
}

async function main() {
  await authenticate();
  const optionTypeId = await createOptionType();
  await sendRfqRequests(optionTypeId);
}

main();
