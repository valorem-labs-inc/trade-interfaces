// 1. Authenticate with Valorem Trade
import { createPromiseClient } from '@bufbuild/connect';
import { createGrpcTransport } from '@bufbuild/connect-node';
import { SiweMessage } from 'siwe';
import { Wallet, providers } from 'ethers';  // v5.5.0
const { JsonRpcProvider } = providers;
import { Auth } from '../gen/valorem/trade/v1/auth_connect';  // generated from auth.proto

// replace with account to use for signing
const PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const NODE_ENDPOINT = 'https://goerli-rollup.arbitrum.io/rpc';

const provider = new JsonRpcProvider(NODE_ENDPOINT);
const signer = new Wallet(PRIVATE_KEY, provider);

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


// 2. Listen for RFQs and respond with offers on Valorem Trade
import { Contract, BigNumber, utils, constants } from 'ethers';  // v5.5.0
const { parseUnits, randomBytes, splitSignature, arrayify, formatUnits } = utils;
import { RFQ } from '../gen/valorem/trade/v1/rfq_connect';  // generated from rfq.proto
import { Action, QuoteResponse } from '../gen/valorem/trade/v1/rfq_pb';  // generated from rfq.proto
import { EthSignature } from '../gen/valorem/trade/v1/types_pb';  // generated from types.proto
import { 
  Order, 
  SignedOrder, 
  ConsiderationItem, 
  OfferItem, 
  OrderType, 
  ItemType 
} from '../gen/valorem/trade/v1/seaport_pb';  // generated from seaport.proto
import { fromH256 } from './lib/fromHToBN';  // library script for H number conversions
import { toH160, toH256 } from './lib/fromBNToH';  // library script for H number conversions
import IValoremOptionsClearinghouse from '../../abi/IValoremOptionsClearinghouse.json';
import IERC20 from '../../abi/IERC20.json';
import IERC1155abi from '../../abi/IERC1155.json';

const VALOREM_CLEAR_ADDRESS = '0x7513F78472606625A9B505912e3C80762f6C9Efb';  // Valorem Clearinghouse on Arb Goerli
const SEAPORT_ADDRESS = '0x00000000006c3852cbEf3e08E8dF289169EdE581';  // seaport 1.1
const USDC_ADDRESS = '0x8AE0EeedD35DbEFe460Df12A20823eFDe9e03458';  // our mock USDC on Arb Goerli
const WETH_ADDRESS = '0x618b9a2Db0CF23Bb20A849dAa2963c72770C1372';  // our mock Wrapped ETH on Arb Goerli

const clearinghouseContract = new Contract(VALOREM_CLEAR_ADDRESS, IValoremOptionsClearinghouse, provider);
const optionTokenContract = new Contract(VALOREM_CLEAR_ADDRESS, IERC1155abi, provider);
const wethContract = new Contract(WETH_ADDRESS, IERC20, provider);


async function respondToRfqs() {
  const rfqClient = createPromiseClient(RFQ, transport);

  // Create your own quote request and response stream handling logic here!

  // empty response used to open the stream
  const emptyQuoteResponse = new QuoteResponse();
  var emptyQuoteResponseStream = async function* () {
    yield emptyQuoteResponse;
  };

  console.log('Listening for RFQs...');

  while (true) {
    for await (const quoteRequest of rfqClient.maker(emptyQuoteResponseStream(), {headers: [['cookie', cookie]]})) {
      console.log('Received a Quote Request...');

      if (!quoteRequest.identifierOrCriteria) {
        console.log('Skipping Quote Request because "identifierOrCriteria" is undefined.');
      };
      const optionId = fromH256(quoteRequest.identifierOrCriteria);

      if (quoteRequest.action !== Action.BUY) { 
        console.log('Skipping Quote Request because only responding to buy requests.');
        continue;
      };

      if (!quoteRequest.amount) {
        console.log('Skipping Quote Request because "amount" is undefined.');
      };
      const optionAmount = fromH256(quoteRequest.amount);

      // get option info
      const optionInfo = await clearinghouseContract.option(optionId);
      if (optionInfo.underlyingAsset !== WETH_ADDRESS) {
        console.log('Skipping Quote Request because only responding to WETH options.');
        continue;
      };
      console.log('Responding to Quote Request to buy', optionAmount.toString(), 'WETH options with ID', optionId.toString());
      console.log('Option info:');
      console.log(optionInfo);

      // approve clearing house transfer of underlying asset
      const totalUnderlyingAmount = optionInfo.underlyingAmount.mul(optionAmount).mul(10);    
      let txReceipt = await (await wethContract.connect(signer).approve(VALOREM_CLEAR_ADDRESS, totalUnderlyingAmount)).wait();
      if (txReceipt.status == 0) { 
        console.log('Skipping responding to RFQ; Underlying ERC20 approval failed.');
        continue;
      };

      // write option with clearing house
      txReceipt = await (await clearinghouseContract.connect(signer).write(optionId, optionAmount)).wait();
      if (txReceipt.status == 0) { 
        console.log('Skipping responding to RFQ; Writing option with clearing house failed.');
        continue;
      };

      // Construct Seaport Offer:
      // Note we use Seaport v1.1; see https://github.com/ProjectOpenSea/seaport/blob/seaport-1.1/docs/SeaportDocumentation.md
      
      // option we are offering
      const offerItem = {
        itemType: ItemType.ERC1155,  // see Seaport ItemType enum
        token: VALOREM_CLEAR_ADDRESS,
        identifierOrCriteria: optionId,
        startAmount: fromH256(quoteRequest.amount),
        endAmount: fromH256(quoteRequest.amount),         
      };
      // price we want for the option
      const USDCprice = parseUnits('100', 6);  // 100 USDC
      const considerationItem = {
        itemType: ItemType.ERC20,
        token: USDC_ADDRESS,
        startAmount: USDCprice.toString(),
        endAmount: USDCprice.toString(),
        recipient: signer.address,
        identifierOrCriteria: BigNumber.from(0),
      };

      const now = (await provider.getBlock(await provider.getBlockNumber())).timestamp;
      const in_2_mins = now + 2 * 60;  // offer expires in 2 minutes
      const salt = `0x${Buffer.from(randomBytes(8)).toString('hex').padStart(64, '0')}`

      const orderComponents = {
        offerer: signer.address,
        zone: constants.AddressZero,
        offer: [ offerItem ],
        consideration: [ considerationItem ],
        orderType: OrderType.FULL_OPEN,
        startTime: now,
        endTime: in_2_mins,
        zoneHash: constants.HashZero,
        salt: salt,
        conduitKey: constants.HashZero,
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
      const splitSig = splitSignature(signature);
      const ethSignature = new EthSignature({
        r: arrayify(splitSig.r),
        s: arrayify(splitSig.s),
        v: arrayify(splitSig.v),
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

      // construct a quote response
      const quoteResponse = new QuoteResponse({
        ulid: quoteRequest.ulid,
        makerAddress: toH160(signer.address),
        order: signedOrder_H,
      });

      console.log('Sending Quote Response with price of', formatUnits(USDCprice, 6), 'USDC for', optionAmount.toString(), 'options.');

      // send response over RFQ service
      const quoteResponseStream = async function* () {
        yield quoteResponse;
      };

      // approve spend of option amount before sending offer
      txReceipt = await (await optionTokenContract.connect(signer).setApprovalForAll(SEAPORT_ADDRESS, true)).wait();
      if (txReceipt.status == 0) { 
        console.log('Skipping responding to RFQ; Option ERC1155 token spend approval failed.');
        continue;
      };
      
      rfqClient.maker(
        quoteResponseStream(), 
        {headers: [['cookie', cookie]]}
      );

      // Fin!
    };
  };
};


async function main(){
  await authenticateWithTrade();
  await respondToRfqs();
}


main();