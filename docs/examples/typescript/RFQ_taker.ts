// 1. Authenticate with Valorem Trade
import { createPromiseClient } from '@bufbuild/connect';
import { createGrpcTransport } from '@bufbuild/connect-node';
import { SiweMessage } from 'siwe';
import * as ethers from 'ethers';  // v5.5.0
import { Auth } from '@/gen/trade/auth_connect';  // generated from auth.proto

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


// 2. Create an option on Valorem Clearinghouse
import IValoremOptionsClearinghouse from '../abi/IValoremOptionsClearinghouse.json';
import { OptionType, getOptionId } from './lib/getOptionId';

const VALOREM_CLEAR_ADDRESS = '0x7513F78472606625A9B505912e3C80762f6C9Efb';  // Valorem Clearinghouse on Arb Goerli
const WETH_ADDRESS = '0x618b9a2Db0CF23Bb20A849dAa2963c72770C1372';  // our mock Wrapped ETH on Arb Goerli
const USDC_ADDRESS = '0x8AE0EeedD35DbEFe460Df12A20823eFDe9e03458';  // our mock USDC on Arb Goerli

const underlyingAsset = WETH_ADDRESS; 
const exerciseAsset = USDC_ADDRESS; 

async function createOption() {
  const clearinghouseContract = new ethers.Contract(VALOREM_CLEAR_ADDRESS, IValoremOptionsClearinghouse, provider);

  const underlyingAmount = ethers.utils.parseUnits('1', 18); // 1 WETH, 18 decimals
  const exerciseAmount = ethers.utils.parseUnits('2000', 6); // 2k USDC, 6 decimals

  const blockNumber = await provider.getBlockNumber();
  const SECONDS_IN_A_WEEK = 60 * 60 * 24 * 7;

  const exerciseTimestamp = (await provider.getBlock(blockNumber))?.timestamp || Math.floor(Date.now()/1000);
  const expiryTimestamp = exerciseTimestamp + SECONDS_IN_A_WEEK;

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
    console.log('Creating option type with clearing house.');
    const newOptionTxReceipt = await (await clearinghouseContract.connect(signer).newOptionType(
      underlyingAsset,
      underlyingAmount,
      exerciseAsset,
      exerciseAmount,
      exerciseTimestamp,
      expiryTimestamp,
    )).wait();
    if (newOptionTxReceipt.status == 0) { throw new Error('Option creation failed.') };
  } else {
    console.log('Nice! Option type already exists with clearing house.');
  };

  console.log('Sending RFQs for option with ID:', optionId.toString());
  return optionId;
}


// 3. Send RFQ requests
import { RFQ } from '../../../gen/trade/rfq_connect';  // generated from rfq.proto
import { Action, QuoteRequest } from '../../../gen/trade/rfq_pb';  // generated from rfq.proto
import { ItemType } from '../../../gen/trade/seaport_pb';  // generated from seaport.proto
import { toH160, toH256 } from './lib/fromBNToH';
import { fromH160, fromH256 } from './lib/fromHToBN';
import ISeaport from '../abi/ISeaport.json';
import IERC20 from '../abi/IERC20.json';

const SEAPORT_ADDRESS = '0x00000000006c3852cbEf3e08E8dF289169EdE581';  // seaport 1.1

async function sendRfqRequests(optionId: ethers.BigNumber) {
  
  const seaportContract = new ethers.Contract(SEAPORT_ADDRESS, ISeaport, provider);
  const usdcContract = new ethers.Contract(USDC_ADDRESS, IERC20, provider);

  const rfqClient = createPromiseClient(RFQ, transport);

  // create a quote request to buy 5 options
  const quoteRequest = new QuoteRequest({
    ulid: undefined,
    takerAddress: toH160(signer.address),
    itemType: ItemType.ERC1155,  // seaport offer ItemType
    tokenAddress: toH160(VALOREM_CLEAR_ADDRESS),  // clearing house is options token contract
    identifierOrCriteria: toH256(optionId),  // token id of the option
    amount: toH256(5),  // 5 options
    action: Action.BUY  
  });

  // continuously send requests and handle responses
  console.log('Sending RFQ requests for option ID', optionId, '...');

  // create your own quote request and response stream handling logic here
  const quoteRequestStream = async function* () {
    yield quoteRequest;
  };

  while (true) {
    for await (const quoteResponse of rfqClient.taker(quoteRequestStream(), {headers: [['cookie', cookie]]})) {

      console.log('Received a Quote Response...');

      // convert order fields from H types back to BigNumbers
      const signedOrder_H = quoteResponse.order;
      const order_H = signedOrder_H.parameters;
      const [ offerItem_H ] = order_H.offers;
      const [ considerationItem_H ] = order_H.considerations;
      
      const offerItem = {
        itemType: offerItem_H.itemType,
        token: ethers.utils.hexValue(fromH160(offerItem_H.token)),
        identifierOrCriteria: fromH256(offerItem_H.identifierOrCriteria),
        startAmount: fromH256(offerItem_H.startAmount),
        endAmount: fromH256(offerItem_H.endAmount),
      };

      const considerationItem = {
        itemType: considerationItem_H.itemType,
        token: ethers.utils.hexValue(fromH160(considerationItem_H.token)),
        identifierOrCriteria: fromH256(considerationItem_H.identifierOrCriteria),
        startAmount: fromH256(considerationItem_H.startAmount),
        endAmount: fromH256(considerationItem_H.endAmount),
        recipient: ethers.utils.hexValue(fromH160(considerationItem_H.recipient)),
      };

      if (considerationItem.token !== USDC_ADDRESS) { continue };  // only accept USDC

      const order = {
        offerer: ethers.utils.hexValue(fromH160(order_H.offerer)),
        zone: ethers.utils.hexValue(fromH160(order_H.zone)),
        offer: [ offerItem ],
        consideration: [ considerationItem ],
        orderType: order_H.orderType,
        startTime: fromH256(order_H.startTime),
        endTime: fromH256(order_H.endTime),
        zoneHash: fromH256(order_H.zoneHash),
        salt: fromH256(order_H.salt),
        conduitKey: fromH256(order_H.conduitKey),
      };

      const signedOrder = {
        parameters: order,
        signature: signedOrder_H.signature,
      };

      // assumes start and end amount are equal
      if (considerationItem.startAmount.gt(ethers.utils.parseUnits('200', 6))) { continue };  // only accept price less than 200 USDC 

      console.log('Accepting quote to buy option for', ethers.utils.formatUnits(considerationItem.startAmount, 6) , 'USDC and executing order on seaport.');

      usdcContract.connect(signer).approve(SEAPORT_ADDRESS, considerationItem.startAmount);

      seaportContract.connect(signer).fullfillOrder(signedOrder, signedOrder.parameters.conduitKey);

    };
  };
};


async function main(){

  await authenticateWithTrade();
  const optionId = await createOption();
  await sendRfqRequests(optionId);

}

main();