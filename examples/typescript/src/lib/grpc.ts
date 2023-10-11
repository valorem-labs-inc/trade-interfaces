import { createGrpcTransport } from '@connectrpc/connect-node';
import { ConnectError, createPromiseClient } from '@connectrpc/connect';
import { Auth } from '../../gen/valorem/trade/v1/auth_connect.js';
import { RFQ } from '../../gen/valorem/trade/v1/rfq_connect.js';
import { GRPC_ENDPOINT } from './constants.js';

let cookie: string; // to be used for all server interactions

// custom Connect-node transport interceptor for retrieving cookie
const trackCookie = (next: any) => async (req: any) => {
  if (cookie !== undefined) {
    req.header = [['cookie', cookie]];
  }
  const res = await next({ ...req, headers: { ...req.headers, cookie } });
  cookie = res.header?.get('set-cookie')?.split(';')[0] ?? cookie;
  return res;
};

// transport for connection to Valorem Trade gRPC server
const transport = createGrpcTransport({
  baseUrl: GRPC_ENDPOINT,
  httpVersion: '2',
  interceptors: [trackCookie],
  nodeOptions: {
    // TODO TLS CERT
    // THIS IS NOT SECURE
    rejectUnauthorized: false,
  },
});

export const authClient = createPromiseClient(Auth, transport);
export const rfqClient = createPromiseClient(RFQ, transport);

export const handleGRPCRequest = async <T>(
  request: () => Promise<T>
): Promise<T | null> => {
  try {
    return await request();
  } catch (error) {
    if (error instanceof ConnectError) {
      const err = ConnectError.from(error);
      console.error(`\nGRPC Error: ${err.message}\nCode: ${err.code}\n`);
    }
    return null;
  }
};
