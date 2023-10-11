import { arbitrum, arbitrumGoerli } from 'viem/chains';

/** Chains */
export const supportedChains = {
  arbitrum,
  arbitrumGoerli,
};
export type SupportedChain =
  (typeof supportedChains)[keyof typeof supportedChains];

/** Contracts */
// Valorem Clearinghouse on Arbitrum One (mainnet) & Arbitrum Goerli (testnet)
export const CLEAR_ADDRESS = '0x402A401B1944EBb5A3030F36Aa70d6b5794190c9';
// Seaport 1.5
export const SEAPORT_ADDRESS = '0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC';
// our mock USDC on Arbitrum Goerli
export const USDC_ADDRESS = '0x8AE0EeedD35DbEFe460Df12A20823eFDe9e03458';
// our mock Wrapped ETH on Arbitrum Goerli
export const WETH_ADDRESS = '0x618b9a2Db0CF23Bb20A849dAa2963c72770C1372';

/** URLs */
export const GRPC_ENDPOINT = 'https://trade.valorem.xyz';
export const DOMAIN = 'trade.valorem.xyz';

/** Time & Dates */
export const ONE_DAY_UNIX = 60 * 60 * 24;
export const ONE_WEEK_UNIX = ONE_DAY_UNIX * 7;

/** Misc */
export const nullBytes32 =
  '0x0000000000000000000000000000000000000000000000000000000000000000';
