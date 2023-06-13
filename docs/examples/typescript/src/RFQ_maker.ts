// 1. Authenticate with Valorem Trade
import { createPromiseClient } from '@bufbuild/connect';
import { createGrpcTransport } from '@bufbuild/connect-node';
import { SiweMessage } from 'siwe';
import * as ethers from 'ethers';  // v5.5.0
import { Auth } from '../gen/valorem/trade/v1/auth_connect';  // generated from auth.proto

// replace with account to use for signing
const PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const NODE_ENDPOINT = 'https://goerli-rollup.arbitrum.io/rpc';

const provider = new ethers.providers.JsonRpcProvider(NODE_ENDPOINT);
const signer = new ethers.Wallet(PRIVATE_KEY, provider);

const gRPC_ENDPOINT = 'https://exchange.valorem.xyz';
const DOMAIN = 'exchange.valorem.xyz';

var cookie: string;  // to be used for all server interactions
// custom Connect interceptor for retrieving cookie
const trackCookie= (next: any) => async (req: any) => {
  const res = await next(req);
  cookie = res.header?.get('set-cookie')?.split(';')[0] ?? cookie;
  return res
};

// transport for connection to Valorem Trade gRPC server
const transport = createGrpcTransport({
  baseUrl: gRPC_ENDPOINT,
  httpVersion: '2',
  interceptors: [trackCookie]
});

async function authenticateWithTrade() {
  const authClient = createPromiseClient(Auth, transport);
  const { nonce } = await authClient.nonce({});
  const { chainId } = await provider.getNetwork();
  // create SIWE message
  const message = new SiweMessage({
    domain: DOMAIN,
    address: signer.address,
    uri: gRPC_ENDPOINT,
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
      })
    },
    {headers: [['cookie', cookie]]},
  );

  // authenticate with Valorem Trade
  await authClient.authenticate({}, {headers: [['cookie', cookie]]});

  console.log('Client has authenticated with Valorem Trade!');
}


// 2. Listen for RFQs and respond with offers
import { RFQ } from '../gen/valorem/trade/v1/rfq_connect';  // generated from rfq.proto
import { Action, QuoteResponse } from '../gen/valorem/trade/v1/rfq_pb';  // generated from rfq.proto
import { fromH256 } from './lib/fromHToBN';
import IValoremOptionsClearinghouse from '../../abi/IValoremOptionsClearinghouse.json';
import IERC20abi from '../../abi/IERC20.json';
import { toH160, toH256 } from './lib/fromBNToH';
import { Order, SignedOrder, ConsiderationItem, OfferItem, OrderType, ItemType } from '../gen/valorem/trade/v1//seaport_pb';
import ISeaport from '../../abi/ISeaport.json';
import { EthSignature } from '../gen/valorem/trade/v1/types_pb';

const SEAPORT_ADDRESS = '0x00000000006c3852cbEf3e08E8dF289169EdE581';  // seaport 1.1
const VALOREM_CLEAR_ADDRESS = '0x7513F78472606625A9B505912e3C80762f6C9Efb';  // Valorem Clearinghouse on Arb Goerli
const USDC_ADDRESS = '0x8AE0EeedD35DbEFe460Df12A20823eFDe9e03458';  // our mock USDC on Arb Goerli

async function respondToRfqs() {
  const seaportContract = new ethers.Contract(SEAPORT_ADDRESS, ISeaport, signer);

  const rfqClient = createPromiseClient(RFQ, transport);

  // create your own quote request and response stream handling logic here

  const emptyQuoteResponse = new QuoteResponse();
  var emptyQuoteResponseStream = async function* () {
    yield emptyQuoteResponse;
  };

  console.log('Listening for RFQs...');

  while (true) {
    for await (const quoteRequest of rfqClient.maker(emptyQuoteResponseStream(), {headers: [['cookie', cookie]]})) {

      console.log('Received a Quote Request.');

      if (quoteRequest.action !== Action.BUY) { 
        console.log('Skipping Quote Request because it is not a buy request.');
        continue;
      };  // only responding to buy requests

      if (!quoteRequest.identifierOrCriteria) {
        console.log('Skipping Quote Request because "identifierOrCriteria" is undefined.');
      };
      const optionType = fromH256(quoteRequest.identifierOrCriteria);

      if (!quoteRequest.amount) {
        console.log('Skipping Quote Request because "amount" is undefined.');
      };
      const optionAmount = fromH256(quoteRequest.amount);

      console.log('Responding to Quote Request for', optionAmount.toString(), 'options with ID' + optionType.toString());

      const clearinghouseContract = new ethers.Contract(VALOREM_CLEAR_ADDRESS, IValoremOptionsClearinghouse, provider);

      // get option info
      const optionInfo = await clearinghouseContract.option(optionType);
      console.log('Option info:');
      console.log(optionInfo);
      
      // approve clearing house transfer of underlying asset
      const underlyingERC20 = new ethers.Contract(optionInfo.underlyingAsset, IERC20abi, provider);
      const approveTxReceipt = await (await underlyingERC20.connect(signer).approve(VALOREM_CLEAR_ADDRESS, optionInfo.underlyingAmount.mul(optionAmount))).wait();
      if (approveTxReceipt.status == 0) { 
        console.log('Skipping responding to RFQ; Underlying ERC20 approval failed.');
        continue;
      };

      // write option with clearing house
      const writeTxReceipt = await (await clearinghouseContract.connect(signer).write(optionType, optionAmount)).wait();
      if (writeTxReceipt.status == 0) { 
        console.log('Skipping responding to RFQ; Writing option with clearing house failed.');
        continue;
      };
      const writeEvent = writeTxReceipt.events.find((event: any) => event.event === 'OptionsWritten');
      const [optionId, claimId] = [writeEvent.args.optionId, writeEvent.args.claimId];

      // Construct Seaport Offer:
      // Option we are offering
      const offerItem = {
        itemType: ItemType.ERC1155,
        token: VALOREM_CLEAR_ADDRESS,
        identifierOrCriteria: optionId,
        startAmount: fromH256(quoteRequest.amount),
        endAmount: fromH256(quoteRequest.amount),         
      };
      // Price we want for the option
      const USDCprice = ethers.utils.parseUnits('100', 6);  // 100 USDC
      const considerationItem = {
        itemType: ItemType.ERC20,
        token: USDC_ADDRESS,
        startAmount: USDCprice.toString(),
        endAmount: USDCprice.toString(),
        recipient: signer.address,
        identifierOrCriteria: ethers.BigNumber.from(0),
      };

      const now = (await provider.getBlock(await provider.getBlockNumber())).timestamp;
      const in_30_mins = now + 30 * 60;
      const counter = await seaportContract.getCounter(signer.address);
      const salt = `0x${Buffer.from(ethers.utils.randomBytes(8)).toString('hex').padStart(64, '0')}`
      // order parameters, see https://arbiscan.io/address/0x00000000006c3852cbEf3e08E8dF289169EdE581#code#F4#L1
      const orderComponents = {
        offerer: signer.address,
        zone: ethers.constants.AddressZero,
        offer: [ offerItem ],
        consideration: [ considerationItem ],
        orderType: OrderType.FULL_OPEN,
        startTime: now,
        endTime: in_30_mins,
        zoneHash: ethers.constants.HashZero,
        salt: salt,
        conduitKey: ethers.constants.HashZero,
        counter: counter,
      };

      // create order signature
      const ORDER_TYPES = {
        OrderComponents: [
          { name: 'offerer', type: 'address' },
          { name: 'zone', type: 'address' },
          { name: 'offer', type: 'OfferItem[]' },
          { name: 'consideration', type: 'ConsiderationItem[]' },
          { name: 'orderType', type: 'uint8' },
          { name: 'startTime', type: 'uint256' },
          { name: 'endTime', type: 'uint256' },
          { name: 'zoneHash', type: 'bytes32' },
          { name: 'salt', type: 'uint256' },
          { name: 'conduitKey', type: 'bytes32' },
          { name: 'counter', type: 'uint256' },
        ],
        OfferItem: [
          { name: 'itemType', type: 'uint8' },
          { name: 'token', type: 'address' },
          { name: 'identifierOrCriteria', type: 'uint256' },
          { name: 'startAmount', type: 'uint256' },
          { name: 'endAmount', type: 'uint256' },
        ],
        ConsiderationItem: [
          { name: 'itemType', type: 'uint8' },
          { name: 'token', type: 'address' },
          { name: 'identifierOrCriteria', type: 'uint256' },
          { name: 'startAmount', type: 'uint256' },
          { name: 'endAmount', type: 'uint256' },
          { name: 'recipient', type: 'address' },
        ],
      };
      // see https://docs.ethers.org/v5/api/signer/#Signer-signTypedData
      const signature = await signer._signTypedData(
        {},  // domain data is optional
        ORDER_TYPES,
        orderComponents
      );
      // Use EIP-2098 compact signatures to save gas.
      const splitSignature = ethers.utils.splitSignature(signature);
      const ethSignature = new EthSignature({
        r: ethers.utils.arrayify(splitSignature.r),
        s: ethers.utils.arrayify(splitSignature.s),
        v: ethers.utils.arrayify(splitSignature.v),
      });

      // convert order fields to H types
      const offerItem_H = new OfferItem({
        itemType: offerItem.itemType,
        token: toH160(offerItem.token),
        identifierOrCriteria: toH256(offerItem.identifierOrCriteria),
        startAmount: toH256(offerItem.startAmount),
        endAmount: toH256(offerItem.endAmount),
      });

      const considerationItem_H = new ConsiderationItem({
        itemType: considerationItem.itemType,
        token: toH160(considerationItem.token),
        identifierOrCriteria: toH256(considerationItem.identifierOrCriteria),
        startAmount: toH256(considerationItem.startAmount),
        endAmount: toH256(considerationItem.endAmount),
        recipient: toH160(considerationItem.recipient),
      });

      const order_H = new Order({
        offerer: toH160(orderComponents.offerer),
        zone: toH160(orderComponents.zone),
        offers: [offerItem_H],
        considerations: [considerationItem_H],
        orderType: orderComponents.orderType,
        startTime: toH256(orderComponents.startTime),
        endTime: toH256(orderComponents.endTime),
        zoneHash: toH256(orderComponents.zoneHash),
        salt: toH256(orderComponents.salt),
        conduitKey: toH256(orderComponents.conduitKey),
      });

      const signedOrder_H = new SignedOrder({
        parameters: order_H,
        signature: ethSignature,
      });

      // construct quote response
      const quoteResponse = new QuoteResponse({
        ulid: quoteRequest.ulid,
        makerAddress: toH160(signer.address),
        order: signedOrder_H,
      });

      console.log('Sending Quote Response with price of', USDCprice.toString(), 'USDC for', optionAmount.toString(), 'options.');
      console.log(quoteResponse);

      // send response over RFQ service
      var quoteResponseStream = async function* () {
        yield quoteResponse;
      };
      rfqClient.maker(
        quoteResponseStream(), 
        {headers: [['cookie', cookie]]}
      );
      
    };
  };
};


async function main(){
  await authenticateWithTrade();
  await respondToRfqs();
}


main();