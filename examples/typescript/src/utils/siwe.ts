import { Address } from 'viem';
import { GRPC_ENDPOINT, DOMAIN } from '../lib/constants.js';

interface CreateSIWEMessageArgs {
  chainId: number;
  address: Address;
  nonce: string;
}

export const createSIWEMessage = ({
  chainId,
  address,
  nonce,
}: CreateSIWEMessageArgs) => {
  return `${DOMAIN} wants you to sign in with your Ethereum account:
${address}

I accept the Valorem Terms of Service at https://app.valorem.xyz/tos and Privacy Policy at https://app.valorem.xyz/privacy

URI: ${GRPC_ENDPOINT}
Version: 1
Chain ID: ${chainId}
Nonce: ${nonce}
Issued At: ${new Date().toISOString()}`;
};
