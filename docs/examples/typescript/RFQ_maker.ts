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
import { Session } from '../../../gen/quay/session_connect';  // generated from auth.proto

// replace with account to use for signing
// const PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
// const NODE_ENDPOINT = 'https://goerli-rollup.arbitrum.io/rpc';

const provider = new ethers.providers.JsonRpcProvider(NODE_ENDPOINT);
const signer = new ethers.Wallet(PRIVATE_KEY, provider);

const CHAIN_ID = 421613;  // Arbitrum Goerli
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
  const authClient = createPromiseClient(Session, transport);
  const { nonce } = await authClient.nonce({});

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
import { RFQ } from '../../../gen/quay/rfq_connect';  // generated from rfq.proto
import { QuoteResponse } from '../../../gen/quay/rfq_pb';  // generated from rfq.proto
import { toH160 } from './lib/fromBNToH';

async function respondToRfqs() {
  const rfqClient = createPromiseClient(RFQ, transport);

  // create your own quote request and response stream handling logic here

  const emptyResponse = new QuoteResponse();
  var emptyResponseStream = async function* () {
    yield emptyResponse;
  };

  console.log('Listening for RFQs...');
  while (true){
    
    const requestStream = rfqClient.maker(
      emptyResponseStream(), 
      {headers: [['cookie', cookie]]}
    );

    
    for await (const request of requestStream) {
      console.log('Received request:', request);
      // Handle the request here
    };
  }

};


async function main(){

  await authenticateWithTrade();
  await respondToRfqs();

}

main();