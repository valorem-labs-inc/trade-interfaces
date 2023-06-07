import { createPromiseClient } from '@bufbuild/connect';
import { createGrpcTransport } from '@bufbuild/connect-node';
import { SiweMessage } from 'siwe';
import * as ethers from 'ethers';
import { Session } from '../gen/session_connect';

const PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const wallet = new ethers.Wallet(PRIVATE_KEY);

const CHAIN_ID = 421613;  // Arbitrum Goerli
const gRPC_ENDPOINT = 'https://exchange.valorem.xyz';
const DOMAIN = 'exchange.valorem.xyz';

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

async function authenticateWithTrade() {
  const sessionClient = createPromiseClient(Session, transport);
  const { nonce } = await sessionClient.nonce({});
  const cookie = lastResponse.header.get('set-cookie').split(';')[0];

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

const NODE_ENDPOINT = 'https://goerli-rollup.arbitrum.io/rpc';
const VALOREM_CLEAR_ADDRESS = '0x7513F78472606625A9B505912e3C80762f6C9Efb';
const underlyingAsset = '0x618b9a2Db0CF23Bb20A849dAa2963c72770C1372';  // Wrapped ETH on Arb Goerli
const exerciseAsset = '0x8FB1E3fC51F3b789dED7557E680551d93Ea9d892';  // USDC on Arb Goerli

async function createOption() {  
  const provider = new ethers.JsonRpcProvider(NODE_ENDPOINT);
  const signer = wallet.connect(provider);

  const settlementContract = new ethers.Contract(VALOREM_CLEAR_ADDRESS, IValoremOptionsClearinghouse, signer);

  const underlyingAmount = BigInt(1 * 10**18);  // WETH = 18 decimals
  const exerciseAmount = BigInt(2000 * 10**6);  // USDCs = 6 decimals  

  const blockNumber = await provider.getBlockNumber();
  const SECONDS_IN_A_WEEK = 60 * 60 * 24 * 7;

  const exerciseTimestamp = (await provider.getBlock(blockNumber))?.timestamp || Math.floor(Date.now()/1000);
  const expiryTimestamp = exerciseTimestamp + SECONDS_IN_A_WEEK;

  const optionId = (await settlementContract.newOptionType.staticCallResult(
    underlyingAsset,
    underlyingAmount,
    exerciseAsset,
    exerciseAmount,
    exerciseTimestamp,
    expiryTimestamp
  ))[0];

  console.log('Created option with ID: ', optionId);
  return optionId;
}


async function main(){

  await authenticateWithTrade();
  const optionId = await createOption();


}

main();