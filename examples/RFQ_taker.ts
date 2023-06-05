// sign in with ethereum https://docs.login.xyz/
import { SiweMessage } from 'siwe';
// gRPC connection packages https://connect.build/docs/node/using-clients
import { createPromiseClient } from '@bufbuild/connect';  
import { createGrpcTransport } from '@bufbuild/connect-node';
// your favourite web3 library
import * as ethers from 'ethers';
// proto generate files
import { Session } from '../gen/session_connect';


// wallet for signing. NOTE: this a a placeholder private key for testing, replace with taker RFQ signer
const wallet = new ethers.Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
// your favourite chain
const NODE_ENDPOINT = 'https://rpc.ankr.com/arbitrum';
const CHAIN_ID = 42161;  // Arbitrum One
// Valorem Trade
const gRPC_ENDPOINT = 'https://exchange.valorem.xyz';
const DOMAIN = 'exchange.valorem.xyz';


const transport = createGrpcTransport({
  baseUrl: gRPC_ENDPOINT,
  httpVersion: '2',
});


async function main() {
  // 1. Connect and authenticate with Valorem Trade API
  const sessionClient = createPromiseClient(Session, transport);

  const nonce = (await sessionClient.nonce({})).nonce;

  const siweMessage = new SiweMessage({
    domain: DOMAIN,
    address: wallet.address,
    uri: gRPC_ENDPOINT,
    version: '1',
    chainId: CHAIN_ID,
    nonce: nonce,
    issuedAt: (new Date()).toISOString(),
  });

  const message = siweMessage.toMessage()

  const signature = await wallet.signMessage(message);

  const body = JSON.stringify({
    message: message,
    signature: signature,
  });

  const verify_response = await sessionClient.verify({
    body: body,
  });




}


main();