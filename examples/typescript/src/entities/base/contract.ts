import { PublicClient, erc20ABI as ERC20_ABI } from '@wagmi/core';
import { CLEAR_ABI, SEAPORT_V1_5_ABI } from 'src/lib/abis';
import { SupportedChain } from 'src/lib/constants';
import {
  Abi,
  Address,
  PrivateKeyAccount,
  Transport,
  WalletClient,
  getContract,
} from 'viem';

type IContract<T extends Abi> = ReturnType<
  typeof getContract<
    Transport,
    Address,
    T,
    SupportedChain,
    PrivateKeyAccount,
    PublicClient<Transport, SupportedChain>,
    WalletClient<Transport, SupportedChain, PrivateKeyAccount>
  >
>;

export interface ContractConstructorArgs {
  address: Address;
  abi: Abi;
  publicClient: PublicClient;
  walletClient: WalletClient;
}

export type IClearinghouse = IContract<typeof CLEAR_ABI>;
export type ISeaport = IContract<typeof SEAPORT_V1_5_ABI>;
export type IERC20 = IContract<typeof ERC20_ABI>;

/** Reusable extension of viem's contract interface */
export class Contract<T extends IClearinghouse | ISeaport | IERC20> {
  public address: Address;
  public read: T['read'];
  public simulate: T['simulate'];
  public write: T['write'];

  private contract: T;

  public constructor({
    address,
    abi,
    publicClient,
    walletClient,
  }: ContractConstructorArgs) {
    this.address = address;
    this.contract = getContract({
      address,
      abi,
      walletClient,
      publicClient,
    }) as unknown as T;

    this.read = this.contract.read;
    this.simulate = this.contract.simulate;
    this.write = this.contract.write;
  }
}
