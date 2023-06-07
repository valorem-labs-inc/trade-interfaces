import * as dotenv from 'dotenv';
dotenv.config();
import * as util from 'util';
function consoleInspect(data:any) {
  console.log(util.inspect(data, {showHidden: false, depth: null, colors: true}));
};
const gRPC_ENDPOINT = 'https://localhost:8000';
const DOMAIN = 'localhost.com';
const NODE_ENDPOINT = 'http://localhost:8545';
const PRIVATE_KEY = process.env.PRIVATE_KEY || '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';


/////////////////////////////////

import { createPromiseClient } from '@bufbuild/connect';
import { createGrpcTransport } from '@bufbuild/connect-node';
import { SiweMessage } from 'siwe';
import * as ethers from 'ethers';
import { Session } from '../gen/session_connect';

// replace with account to use for signing
// const PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const wallet = new ethers.Wallet(PRIVATE_KEY);

const CHAIN_ID = 421613;  // Arbitrum Goerli  // const CHAIN_ID = 42161; // Arbitrum One
// const gRPC_ENDPOINT = 'https://exchange.valorem.xyz';
// const DOMAIN = 'exchange.valorem.xyz';

var lastResponse: any;

const trackResponse = (next: any) => async (req: any) => {
  const res = await next(req);
  lastResponse = res;
  return res
};
const transport = createGrpcTransport({
  baseUrl: gRPC_ENDPOINT,
  httpVersion: '2',
  interceptors: [trackResponse]
});

var cookie: string;

async function authenticateWithTrade() {
  const sessionClient = createPromiseClient(Session, transport);

  const { nonce } = await sessionClient.nonce({});

  cookie = lastResponse.header.get('set-cookie').split(';')[0];

  const message = new SiweMessage({
    domain: DOMAIN,
    address: wallet.address,
    uri: gRPC_ENDPOINT,
    version: '1',
    chainId: CHAIN_ID,
    nonce,
    issuedAt: new Date().toISOString(),
  }).toMessage();

  const signature = await wallet.signMessage(message);

  await sessionClient.verify(
    {
      body: JSON.stringify({
        message: message,
        signature: signature,
      })
    },
    {headers: [['cookie', cookie]]},
  );

  await sessionClient.authenticate({}, {headers: [['cookie', cookie]]});

  console.log('Client has authenticated with Valorem Trade!');
}


import IValoremOptionsClearinghouse from '../abi/IValoremOptionsClearinghouse.json';

// const NODE_ENDPOINT = 'https://goerli-rollup.arbitrum.io/rpc';
const VALOREM_CLEAR_ADDRESS = '0x7513F78472606625A9B505912e3C80762f6C9Efb';
const underlyingAsset = '0x618b9a2Db0CF23Bb20A849dAa2963c72770C1372';  // Wrapped ETH on Arb Goerli
const exerciseAsset = '0x8AE0EeedD35DbEFe460Df12A20823eFDe9e03458';  // USDC on Arb Goerli

const provider = new ethers.providers.JsonRpcProvider(NODE_ENDPOINT);
const signer = wallet.connect(provider);

async function createOption() {
  const settlementContract = new ethers.Contract(VALOREM_CLEAR_ADDRESS, IValoremOptionsClearinghouse, signer);

  const underlyingAmount = BigInt(1 * 10**18);  // WETH = 18 decimals
  const exerciseAmount = BigInt(2000 * 10**6);  // USDCs = 6 decimals  

  const blockNumber = await provider.getBlockNumber();
  const SECONDS_IN_A_WEEK = 60 * 60 * 24 * 7;

  const exerciseTimestamp = (await provider.getBlock(blockNumber))?.timestamp || Math.floor(Date.now()/1000);
  const expiryTimestamp = exerciseTimestamp + SECONDS_IN_A_WEEK;

  // const response = await settlementContract.newOptionType(
  //   underlyingAsset,
  //   underlyingAmount,
  //   exerciseAsset,
  //   exerciseAmount,
  //   exerciseTimestamp,
  //   expiryTimestamp,
  // );
  // const receipt = await response.wait();
  // const optionId = receipt.events[0].args['optionId'];
  const optionId = await settlementContract.callStatic.newOptionType(
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


// import IERC20abi from '../abi/IERC20.json';
// import ISeaport from '../abi/ISeaport.json';

// const SEAPORT_ADDRESS = '0x00000000006c3852cbEf3e08E8dF289169EdE581';
// const seaportContract = new ethers.Contract(SEAPORT_ADDRESS, ISeaport, signer);


import { RFQ } from '../gen/rfq_connect';
import { Action, QuoteRequest } from '../gen/rfq_pb';
import { ItemType } from '../gen/seaport_pb';
// import { toH160, toH256 } from '../lib/fromBNToH';
import { toH160, toH256 } from '../lib/fromBNToH';
import { BigNumber } from 'ethers';
import type { BigNumberish } from 'ethers';

async function createBuyRequest(optionId: BigNumber) {
  const rfqClient = createPromiseClient(RFQ, transport);

  // const underlyingERC20 = new ethers.Contract(underlyingAsset, IERC20abi, provider);
  // const exerciseERC20 = new ethers.Contract(exerciseAsset, IERC20abi, provider);
  // console.log('balance of underlying asset before: ', ethers.utils.formatEther(((await underlyingERC20.balanceOf(wallet.address)))));
  // console.log('balance of exercise asset before: ', ((await exerciseERC20.balanceOf(wallet.address))));

  const request = new QuoteRequest({
    ulid: undefined,
    takerAddress: toH160(wallet.address),
    itemType: ItemType.NATIVE,
    tokenAddress: toH160(VALOREM_CLEAR_ADDRESS),
    identifierOrCriteria: toH256(optionId),
    amount: toH256(BigInt(5)),
    action: Action.BUY
  });

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

  await createBuyRequest(optionId);

}

main();