import * as dotenv from 'dotenv';
dotenv.config();
const gRPC_ENDPOINT = 'https://localhost:8000';
const DOMAIN = 'localhost.com';
const NODE_ENDPOINT = 'http://localhost:8545';
const PRIVATE_KEY = process.env.PRIVATE_KEY || '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
// 1. Authenticate with Valorem Trade
import { createPromiseClient } from '@bufbuild/connect';
import { createGrpcTransport } from '@bufbuild/connect-node';
import { SiweMessage } from 'siwe';
import * as ethers from 'ethers';  // v5.5.0
import { Auth } from '../../../gen/trade/auth_connect';  // generated from auth.proto

// replace with account to use for signing
// const PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
// const NODE_ENDPOINT = 'https://goerli-rollup.arbitrum.io/rpc';

const provider = new ethers.providers.JsonRpcProvider(NODE_ENDPOINT);
const signer = new ethers.Wallet(PRIVATE_KEY, provider);

// const gRPC_ENDPOINT = 'https://exchange.valorem.xyz';
// const DOMAIN = 'exchange.valorem.xyz';

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
import { RFQ } from '../../../gen/trade/rfq_connect';  // generated from rfq.proto
import { Action, QuoteResponse } from '../../../gen/trade/rfq_pb';  // generated from rfq.proto
import { fromH256 } from './lib/fromHToBN';
import IValoremOptionsClearinghouse from '../abi/IValoremOptionsClearinghouse.json';
import IERC20abi from '../abi/IERC20.json';
import { toH160, toH256 } from './lib/fromBNToH';
import { Order, SignedOrder, ConsiderationItem, OfferItem, OrderType, ItemType } from '../../../gen/trade/seaport_pb';
import ISeaport from '../abi/ISeaport.json';
import { EthSignature } from '../../../gen/trade/types_pb';


const SEAPORT_ADDRESS = '0x00000000006c3852cbEf3e08E8dF289169EdE581';

const VALOREM_CLEAR_ADDRESS = '0x7513F78472606625A9B505912e3C80762f6C9Efb';  // Valorem Clearinghouse on Arb Goerli
const USDC_ADDRESS = '0x8AE0EeedD35DbEFe460Df12A20823eFDe9e03458';  // USDC on Arb Goerli

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
    
    const quoteRequestStream = rfqClient.maker(
      emptyQuoteResponseStream(), 
      {headers: [['cookie', cookie]]}
    );

    for await (const quoteRequest of quoteRequestStream) {
      console.log('Received QuoteRequest:');
      console.log(quoteRequest);

      if (quoteRequest.action !== Action.BUY) { continue };  // only responding to buy requests};

      const optionType = quoteRequest.identifierOrCriteria
        ? fromH256(quoteRequest.identifierOrCriteria)
        : (() => { throw new Error('QuoteRequest "identifierOrCriteria" is undefined.') })(); 

      const optionAmount = quoteRequest.amount
        ? fromH256(quoteRequest.amount)
        : (() => { throw new Error('QuoteRequest "amount" is undefined.') })();

      const clearinghouseContract = new ethers.Contract(VALOREM_CLEAR_ADDRESS, IValoremOptionsClearinghouse, provider);

      // get option info
      const optionInfo = await clearinghouseContract.option(optionType);
      
      // approve clearing house transfer of underlying asset
      const underlyingERC20 = new ethers.Contract(optionInfo.underlyingAsset, IERC20abi, provider);
      const approveTxReceipt = await (await underlyingERC20.connect(signer).approve(VALOREM_CLEAR_ADDRESS, optionInfo.underlyingAmount.mul(optionAmount))).wait();
      if (approveTxReceipt.status == 0) { throw new Error('Underlying ERC20 approval failed.') };

      const writeTxReceipt = await (await clearinghouseContract.connect(signer).write(optionType, optionAmount)).wait();
      if (writeTxReceipt.status == 0) { throw new Error('Writing option with clearing house failed.') };
      const writeEvent = writeTxReceipt.events.find((event: any) => event.event === 'OptionsWritten');
      const [optionId, claimId] = [writeEvent.args.optionId, writeEvent.args.claimId];

      // Option we are offering
      const offerItem = new OfferItem({
        itemType: ItemType.ERC1155,
        token: toH160(VALOREM_CLEAR_ADDRESS),
        identifierOrCriteria: toH256(optionId),
        startAmount: quoteRequest.amount,
        endAmount: quoteRequest.amount,
      });
      const USDC_price = ethers.utils.parseUnits('100', 6);  // 100 USDC
      // Price we want for the option
      const considerationItem = new ConsiderationItem({
        itemType: ItemType.ERC20,
        token: toH160(USDC_ADDRESS),  // USDC on Arb Goerli
        // identifierOrCriteria: undefined,  // optional so remove?
        startAmount: toH256(USDC_price),
        endAmount: toH256(USDC_price),  
        recipient: quoteRequest.takerAddress,
      });    

      const now = (await provider.getBlock(await provider.getBlockNumber())).timestamp;
      const in_30_mins = now + 30 * 60;
      const salt = `0x${Buffer.from(ethers.utils.randomBytes(8)).toString("hex").padStart(64, "0")}`

      const orderParameters = new Order({
        offerer: toH160(signer.address),
        zone: toH160(ethers.constants.AddressZero),
        offers: [offerItem],
        considerations: [considerationItem],
        orderType: OrderType.FULL_OPEN,  // this can change based on MM strategy
        startTime: toH256(now),
        endTime: toH256(in_30_mins),
        zoneHash: toH256(ethers.constants.HashZero),
        salt: toH256(salt),
        conduitKey: toH256(ethers.constants.HashZero),
      });

      // create order signature
      let counter = await seaportContract.getCounter(signer.address);

      const offer = [
        {
          itemType: ItemType.ERC1155,
          token: VALOREM_CLEAR_ADDRESS,
          identifierOrCriteria: optionId,
          startAmount: fromH256(quoteRequest.amount),
          endAmount: fromH256(quoteRequest.amount),         
        }
      ];

      const considerationData = [
        {
          itemType: ItemType.ERC20,
          token: ethers.constants.AddressZero,
          startAmount: USDC_price.toString(),
          endAmount: USDC_price.toString(),
          recipient: signer.address,
          identifierOrCriteria: ethers.BigNumber.from(0),
        }
      ];

      const orderComponents = {
        offerer: signer.address,
        zone: ethers.constants.AddressZero,
        offer,
        consideration: considerationData,
        orderType: OrderType.FULL_OPEN,
        totalOriginalConsiderationItems: considerationData.length,
        salt,
        startTime: now,
        endTime: in_30_mins,
        zoneHash: ethers.constants.HashZero,
        conduitKey: ethers.constants.HashZero,
        counter: counter,
      };
  
      const { chainId } = await provider.getNetwork();
      const domainData = {
        name: "Seaport",
        version: "1.1",
        chainId: chainId,
        verifyingContract: SEAPORT_ADDRESS,
      };

      const EIP_1155_ORDER_TYPE = {
        OrderComponents: [
          { name: "offerer", type: "address" },
          { name: "zone", type: "address" },
          { name: "offer", type: "OfferItem[]" },
          { name: "consideration", type: "ConsiderationItem[]" },
          { name: "orderType", type: "uint8" },
          { name: "startTime", type: "uint256" },
          { name: "endTime", type: "uint256" },
          { name: "zoneHash", type: "bytes32" },
          { name: "salt", type: "uint256" },
          { name: "conduitKey", type: "bytes32" },
          { name: "counter", type: "uint256" },
        ],
        OfferItem: [
          { name: "itemType", type: "uint8" },
          { name: "token", type: "address" },
          { name: "identifierOrCriteria", type: "uint256" },
          { name: "startAmount", type: "uint256" },
          { name: "endAmount", type: "uint256" },
        ],
        ConsiderationItem: [
          { name: "itemType", type: "uint8" },
          { name: "token", type: "address" },
          { name: "identifierOrCriteria", type: "uint256" },
          { name: "startAmount", type: "uint256" },
          { name: "endAmount", type: "uint256" },
          { name: "recipient", type: "address" },
        ],
      };

      const signature = await signer._signTypedData(
        domainData,
        EIP_1155_ORDER_TYPE,
        orderComponents
      );
  
      // Use EIP-2098 compact signatures to save gas.
      const splitSignature = ethers.utils.splitSignature(signature);

      const ethSignature = new EthSignature({
        r: ethers.utils.arrayify(splitSignature.r),
        s: ethers.utils.arrayify(splitSignature.s),
        v: ethers.utils.arrayify(splitSignature.v),
      });

      const signerOrder = new SignedOrder({
        parameters: orderParameters,
        signature: ethSignature,
      });

      const quoteResponse = new QuoteResponse({
        ulid: quoteRequest.ulid,
        makerAddress: toH160(signer.address),
        order: signerOrder,
      });

      var quoteResponseStream = async function* () {
        yield quoteResponse;
      };

      rfqClient.maker(
        quoteResponseStream(), 
        {headers: [['cookie', cookie]]}
      );
      
    };
  }
};


async function main(){
  await authenticateWithTrade();
  await respondToRfqs();
}


main();