import { createPromiseClient } from "@bufbuild/connect";
import { createGrpcTransport } from "@bufbuild/connect-node";
import { SiweMessage } from "siwe";
import * as ethers from "ethers";
import { Session } from "../gen/session_connect";

const privateKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

const CHAIN_ID = 42161; // Arbitrum One
const gRPC_ENDPOINT = 'https://exchange.valorem.xyz';
const DOMAIN = "exchange.valorem.xyz";

var lastResponse: any;
const trackResponse = (next: any) => async (req: any) => {
  const res = await next(req);
  lastResponse = res;
  return res
};
const transport = createGrpcTransport({
  baseUrl: gRPC_ENDPOINT,
  httpVersion: "2",
  interceptors: [trackResponse]
});

async function authenticateWithTrade() {
  const sessionClient = createPromiseClient(Session, transport);
  const { nonce } = await sessionClient.nonce({});
  const cookie = lastResponse.header.get('set-cookie').split(';')[0];
  const wallet = new ethers.Wallet(privateKey);

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

authenticateWithTrade();
