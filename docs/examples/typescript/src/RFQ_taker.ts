import {
  Action,
  QuoteRequest,
  QuoteResponse,
} from '../gen/valorem/trade/v1/rfq_pb'; // generated from rfq.proto
import { ItemType } from '../gen/valorem/trade/v1/seaport_pb'; // generated from seaport.proto
import { Auth } from '../gen/valorem/trade/v1/auth_connect'; // generated from auth.proto
import { RFQ } from '../gen/valorem/trade/v1/rfq_connect'; // generated from rfq.proto

import { createPromiseClient } from '@bufbuild/connect';
import { createGrpcTransport } from '@bufbuild/connect-node';
import { SiweMessage } from 'siwe';

import {
  constants,
  Contract,
  providers,
  utils,
  Wallet,
  BigNumber,
} from 'ethers'; // v5.5.0
const { formatUnits, hexValue, hexlify, joinSignature, parseUnits } = utils;
const { JsonRpcProvider } = providers;

import { getOptionId, OptionType } from './lib/getOptionId'; // emulates clearing house newOptionType to compute optionId
import { toH160, toH256 } from './lib/fromBNToH'; // library script for H number conversions
import { fromH160, fromH256 } from './lib/fromHToBN'; // library script for H number conversions

import IValoremOptionsClearinghouse from '../../abi/IValoremOptionsClearinghouse.json';
import ISeaport from '../../abi/ISeaport.json';
import IERC20 from '../../abi/IERC20.json';

const PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // replace with account to use for signing
const NODE_ENDPOINT = 'https://goerli-rollup.arbitrum.io/rpc';
const GRPC_ENDPOINT = 'https://exchange.valorem.xyz';
const DOMAIN = 'exchange.valorem.xyz';
const SECONDS_IN_A_WEEK = 60 * 60 * 24 * 7;

const VALOREM_CLEAR_ADDRESS = '0x7513F78472606625A9B505912e3C80762f6C9Efb'; // Valorem Clearinghouse on Arb Goerli
const SEAPORT_ADDRESS = '0x00000000006c3852cbEf3e08E8dF289169EdE581'; // Seaport 1.1
const USDC_ADDRESS = '0x8AE0EeedD35DbEFe460Df12A20823eFDe9e03458'; // our mock USDC on Arb Goerli
const WETH_ADDRESS = '0x618b9a2Db0CF23Bb20A849dAa2963c72770C1372'; // our mock Wrapped ETH on Arb Goerli

// 1. Authenticate with Valorem Trade
const provider = new JsonRpcProvider(NODE_ENDPOINT);
const signer = new Wallet(PRIVATE_KEY, provider);

let cookie: string; // to be used for all server interactions
// custom Connect-node transport interceptor for retrieving cookie
const trackCookie = (next: any) => async (req: any) => {
  const res = await next(req);
  cookie = res.header?.get('set-cookie')?.split(';')[0] ?? cookie;
  return res;
};

// transport for connection to Valorem Trade gRPC server
const transport = createGrpcTransport({
  baseUrl: GRPC_ENDPOINT,
  httpVersion: '2',
  interceptors: [trackCookie],
});

async function authenticateWithTrade() {
  /* Authenticate with Valorem Trade */

  const authClient = createPromiseClient(Auth, transport);
  const { nonce } = await authClient.nonce({});
  const { chainId } = await provider.getNetwork();

  // create SIWE message
  const message = new SiweMessage({
    domain: DOMAIN,
    address: signer.address,
    uri: GRPC_ENDPOINT,
    version: '1',
    chainId: chainId,
    nonce,
    issuedAt: new Date().toISOString(),
  }).toMessage();

  // sign SIWE message
  const signature = await signer.signMessage(message);

  // verify with Valorem Trade
  await authClient.verify(
    {
      body: JSON.stringify({
        message: message,
        signature: signature,
      }),
    },
    { headers: [['cookie', cookie]] }
  );

  // authenticate with Valorem Trade
  await authClient.authenticate({}, { headers: [['cookie', cookie]] });

  console.log('Client has authenticated with Valorem Trade!');
}

// 2. Initialize an option with Valorem Clearinghouse
async function createOption() {
  /* Initialize an option with Valorem Clearinghouse */

  const clearinghouseContract = new Contract(
    VALOREM_CLEAR_ADDRESS,
    IValoremOptionsClearinghouse,
    provider
  );

  const underlyingAsset = WETH_ADDRESS;
  const exerciseAsset = USDC_ADDRESS;
  const underlyingAmount = parseUnits('1', 18); // 1 WETH, 18 decimals
  const exerciseAmount = parseUnits('2000', 6); // 2k USDC, 6 decimals

  const blockNumber = await provider.getBlockNumber();
  const exerciseTimestamp =
    (await provider.getBlock(blockNumber))?.timestamp ||
    Math.floor(Date.now() / 1000);
  const expiryTimestamp = exerciseTimestamp + SECONDS_IN_A_WEEK; // expires in 1 week

  const option: OptionType = {
    underlyingAsset,
    underlyingAmount,
    exerciseAsset,
    exerciseAmount,
    exerciseTimestamp,
    expiryTimestamp,
  };

  // check if option already exists
  const optionId = getOptionId(option);
  const typeOfToken = await clearinghouseContract.tokenType(optionId);

  // if it does not exist, create it
  if (typeOfToken == 0) {
    console.log('Initializing option type with clearing house.');
    console.log('Option info:');
    console.log(option);
    let txReceipt = await (
      await clearinghouseContract
        .connect(signer)
        .newOptionType(
          underlyingAsset,
          underlyingAmount,
          exerciseAsset,
          exerciseAmount,
          exerciseTimestamp,
          expiryTimestamp
        )
    ).wait();
    if (txReceipt.status == 0) {
      throw new Error('Option creation failed.');
    }
  } else {
    console.log('Nice! Option type already exists with clearing house.');
  }

  return optionId;
}

// 3. Send RFQ requests, then and execute the returned signed offers on Seaport
async function sendRfqRequests(optionId: BigNumber) {
  /* Send RFQ requests, then and execute the returned signed offers on Seaport */

  const rfqClient = createPromiseClient(RFQ, transport);

  // Create your own quote request and response stream handling logic here!

  // create a quote request to buy 5 options
  const quoteRequest = new QuoteRequest({
    takerAddress: toH160(signer.address),
    itemType: ItemType.ERC1155, // see Seaport ItemType enum
    tokenAddress: toH160(VALOREM_CLEAR_ADDRESS), // clearing house is the options token contract
    identifierOrCriteria: toH256(optionId), // the erc1155 token id = optionId
    amount: toH256(5), // 5 options
    action: Action.BUY,
  });

  // continuously send requests and handle responses
  console.log('Sending RFQs for option ID', optionId.toString());

  // create your own quote request and response stream handling logic here
  const quoteRequestStream = async function* () {
    yield quoteRequest;
  };

  while (true) {
    for await (const quoteResponse of rfqClient.taker(quoteRequestStream(), {
      headers: [['cookie', cookie]],
    })) {
      if (Object.keys(quoteResponse).length === 0) {
        continue;
      } // empty response
      console.log('Received a quote response...');

      // format the response into an order to be executed on seaport
      const signedOrder = await formatQuoteResponse(quoteResponse);

      console.log(
        'Accepting quote to buy',
        signedOrder.parameters.offer[0].startAmount,
        'options for',
        formatUnits(signedOrder.parameters.consideration[0].startAmount, 6),
        'USDC.'
      );

      console.log('Executing order on Seaport...');

      // first approve Seaport spend of usdc price

      const usdcContract = new Contract(USDC_ADDRESS, IERC20, provider);

      let txReceipt = await (
        await usdcContract
          .connect(signer)
          .approve(
            SEAPORT_ADDRESS,
            signedOrder.parameters.consideration[0].startAmount
          )
      ).wait(); // assumes start and end are the same
      if (txReceipt.status == 0) {
        console.log('Skipping executing order; USDC approval failed.');
        return;
      }

      // then execute the order
      const seaportContract = new Contract(SEAPORT_ADDRESS, ISeaport, provider);

      txReceipt = await (
        await seaportContract
          .connect(signer)
          .fulfillOrder(signedOrder, constants.HashZero)
      ).wait();
      if (txReceipt.status == 0) {
        console.log('Skipping executing order; order fulfillment failed.');
        return;
      }

      console.log('Success!');
      console.log('txn hash:', txReceipt.transactionHash);
    }
  }
}

// 4. Format quote responses from makers into the signed order for Seaport
async function formatQuoteResponse(quoteResponse: QuoteResponse) {
  /* Format quote responses from makers into the signed order for Seaport */

  // convert order fields from H types back to BigNumbers
  const signedOrder_H = quoteResponse.order;
  const order_H = signedOrder_H.parameters;
  const [offerItem_H] = order_H.offers;
  const [considerationItem_H] = order_H.considerations;

  const offerItem = {
    itemType: offerItem_H.itemType,
    token: hexValue(fromH160(offerItem_H.token)),
    identifierOrCriteria: fromH256(offerItem_H.identifierOrCriteria),
    startAmount: fromH256(offerItem_H.startAmount),
    endAmount: fromH256(offerItem_H.endAmount),
  };
  const considerationItem = {
    itemType: considerationItem_H.itemType,
    token: hexValue(fromH160(considerationItem_H.token)),
    identifierOrCriteria: fromH256(considerationItem_H.identifierOrCriteria),
    startAmount: fromH256(considerationItem_H.startAmount),
    endAmount: fromH256(considerationItem_H.endAmount),
    recipient: hexValue(fromH160(considerationItem_H.recipient)),
  };

  if (considerationItem.token !== USDC_ADDRESS) {
    console.log('Skipping responding to RFQ; only accepting quotes in USDC.');
    return;
  }

  const OrderComponents = {
    offerer: hexValue(fromH160(order_H.offerer)),
    zone: hexValue(fromH160(order_H.zone)),
    offer: [offerItem],
    consideration: [considerationItem],
    orderType: order_H.orderType,
    startTime: fromH256(order_H.startTime),
    endTime: fromH256(order_H.endTime),
    zoneHash: fromH256(order_H.zoneHash),
    salt: fromH256(order_H.salt),
    conduitKey: fromH256(order_H.conduitKey),
  };

  const signature = joinSignature({
    r: hexlify(signedOrder_H.signature.r),
    s: hexlify(signedOrder_H.signature.s),
    v: BigNumber.from(hexlify(signedOrder_H.signature.v)).toNumber(),
  }) as `0x${string}`;

  const signedOrder = {
    parameters: OrderComponents,
    signature: signature,
  };

  if (considerationItem.startAmount.gt(parseUnits('200', 6))) {
    // assumes start and end amount are equal
    console.log(
      'Skipping responding to RFQ; only accepting quotes for 200 USDC or less.'
    );
    return;
  }

  return signedOrder;
}

async function main() {
  await authenticateWithTrade();
  const optionId = await createOption();
  await sendRfqRequests(optionId);
}

main();
