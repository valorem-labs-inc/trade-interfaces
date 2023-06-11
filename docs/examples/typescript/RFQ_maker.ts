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
  const authClient = createPromiseClient(Auth, transport);
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
import { RFQ } from '../../../gen/trade/rfq_connect';  // generated from rfq.proto
import { QuoteRequest, QuoteResponse } from '../../../gen/trade/rfq_pb';  // generated from rfq.proto
import { fromH256 } from './lib/fromHToBN';
import IValoremOptionsClearinghouse from '../abi/IValoremOptionsClearinghouse.json';
import IERC20abi from '../abi/IERC20.json';
import { toH256 } from './lib/fromBNToH';
import { H40, H96, H128, H160, H256 } from '../../../gen/trade/types_pb';

const VALOREM_CLEAR_ADDRESS = '0x7513F78472606625A9B505912e3C80762f6C9Efb';  // Valorem Clearinghouse on Arb Goerli


async function respondToRfqs() {
  const rfqClient = createPromiseClient(RFQ, transport);

  // create your own quote request and response stream handling logic here

  const emptyResponse = new QuoteResponse();
  var emptyResponseStream = async function* () {
    yield emptyResponse;
  };

  console.log('Listening for RFQs...');
  while (true) {
    
    const requestStream = rfqClient.maker(
      emptyResponseStream(), 
      {headers: [['cookie', cookie]]}
    );

    for await (const request of requestStream) {
      console.log('Received request:', request);

      const optionType = request.identifierOrCriteria
        ? fromH256(request.identifierOrCriteria)
        : (() => { throw new Error('QuoteRequest "identifierOrCriteria" is undefined.') })(); 

      const optionAmount = request.amount
        ? fromH256(request.amount)
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
      
      


      // 11 components of signed Seaport offer
      // 1. offerer - aproves order via signature - standard 65-byte EDCSA, 64-byte EIP-2098, or an EIP-1271 isValidSignature check
      // 2. zone (optional)
      // 3. offer - array of items to be transferred
        // - itemType - native, ERC20, ERC721, ERC1155, ERC721 with "criteria" (explained below), and ERC1155 with criteria.
        // - token
        // - identifierOrCriteria
        // - start amount - amount required should the order be fullfilled the moment it becomes active
        // - end amount - amount required should the order be fullfilled the moment it expires, realised amount is calc linearly
      // 4. consideration - array of items that must be received to fullfil order. includes recipient that will receive each. Fullfiller make extend to support tipping.
      // 5. orderType [FULL (doesnt support partial fills), PARTIAL (enables partical fill), 
      //               OPEN (call to execute can be submitted by any account), RESTRICTED (requires zone on the order returns magic value idicating order is approved upon calling validateOrder)]
      // 6. startTime - block timestamp when becomes active
      // 7. endTime - block timetstamp when expires
      // 8. zoneHash
      // 9. salt
      // 10. conduitKey - bytes32 value to indicate what conduit if any should be ised as a source of token approvals - dafault is seaport
      // 11. counter

      // to create an offer:
      // 1. offerer has sufficient balances
      // 2. offerer has approved the transfer of tokens to seaport

      // to fullfill an order:
      // 1. fullfiller needs sufficient balances of all consideration items except those with the offer itemType
      // 2. approvals set for seaport
      // (3.) if native itemType, nees to supply amount in msg.value


      
    };
  }

};


async function main(){

  await authenticateWithTrade();
  await respondToRfqs();

}

main();