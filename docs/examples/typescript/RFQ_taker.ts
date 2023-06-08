// 1. Authenticate with Valorem Trade
import { createPromiseClient } from '@bufbuild/connect';
import { createGrpcTransport } from '@bufbuild/connect-node';
import { SiweMessage } from 'siwe';
import * as ethers from 'ethers';
import { Session } from '@gen/quay/session_connect';

// replace with account to use for signing
const PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const NODE_ENDPOINT = 'https://goerli-rollup.arbitrum.io/rpc';

const provider = new ethers.providers.JsonRpcProvider(NODE_ENDPOINT);
const signer = new ethers.Wallet(PRIVATE_KEY, provider);

const CHAIN_ID = 421613;  // Arbitrum Goerli
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
  const sessionClient = createPromiseClient(Session, transport);
  const { nonce } = await sessionClient.nonce({});

  // create SIWE message
  const message = new SiweMessage({
    domain: DOMAIN,
    address: signer.address,
    uri: gRPC_ENDPOINT,
    version: '1',
    chainId: CHAIN_ID,
    nonce,
    issuedAt: new Date().toISOString(),
  }).toMessage();

  // sign SIWE message
  const signature = await signer.signMessage(message);

  // verify with Valorem Trade
  await sessionClient.verify(
    {
      body: JSON.stringify({
        message: message,
        signature: signature,
      })
    },
    {headers: [['cookie', cookie]]},
  );

  // authenticate with Valorem Trade
  await sessionClient.authenticate({}, {headers: [['cookie', cookie]]});

  console.log('Client has authenticated with Valorem Trade!');
}


// 2. Create an option on Valorem Clearinghouse
import IValoremOptionsClearinghouse from '../abi/IValoremOptionsClearinghouse.json';

const VALOREM_CLEAR_ADDRESS = '0x7513F78472606625A9B505912e3C80762f6C9Efb';  // Valorem Clearinghouse on Arb Goerli
const underlyingAsset = '0x618b9a2Db0CF23Bb20A849dAa2963c72770C1372';  // Wrapped ETH on Arb Goerli
const exerciseAsset = '0x8AE0EeedD35DbEFe460Df12A20823eFDe9e03458';  // USDC on Arb Goerli

async function createOption() {
  const clearinghouseContract = new ethers.Contract(VALOREM_CLEAR_ADDRESS, IValoremOptionsClearinghouse, provider);

  const underlyingAmount = BigInt(1 * 10**18);  // 1 WETH, 18 decimals
  const exerciseAmount = BigInt(2000 * 10**6);  // 2k USDC, 6 decimals  

  const blockNumber = await provider.getBlockNumber();
  const SECONDS_IN_A_WEEK = 60 * 60 * 24 * 7;

  const exerciseTimestamp = (await provider.getBlock(blockNumber))?.timestamp || Math.floor(Date.now()/1000);
  const expiryTimestamp = exerciseTimestamp + SECONDS_IN_A_WEEK;

  const optionId = await clearinghouseContract.connect(signer).newOptionType(
    underlyingAsset,
    underlyingAmount,
    exerciseAsset,
    exerciseAmount,
    exerciseTimestamp,
    expiryTimestamp,
  );

  console.log('Created option with ID:', optionId.toString());
  return optionId;
}


// 3. Create an RFQ request
import { RFQ } from '@gen/quay/rfq_connect';
import { Action, QuoteRequest } from '@gen/quay/rfq_pb';
import { ItemType } from '@gen/quay/seaport_pb';
import { toH160, toH256 } from './lib/fromBNToH';

async function createRequest(optionId: ethers.BigNumber) {
  const rfqClient = createPromiseClient(RFQ, transport);

  // create an option buy quote request 
  const request = new QuoteRequest({
    ulid: undefined,
    takerAddress: toH160(signer.address),
    itemType: ItemType.NATIVE,
    tokenAddress: toH160(VALOREM_CLEAR_ADDRESS),
    identifierOrCriteria: toH256(optionId),
    amount: toH256(BigInt(5)),
    action: Action.BUY
  });

  // create your own quote request and response stream handling logic here
  const requestStream = async function* () {
    yield request;
  };

  const responseStream = rfqClient.taker(
    requestStream(), 
    {headers: [['cookie', cookie]]}
  );

  for await (const response of responseStream) {
    console.log(response);
  }
};


async function main(){

  await authenticateWithTrade();
  const optionId = await createOption();
  await createRequest(optionId);

}

main();