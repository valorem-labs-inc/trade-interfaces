import {
  IClearinghouse,
  Contract,
  ContractConstructorArgs,
} from '../base/contract.js';
import { CLEAR_ADDRESS } from '../../lib/constants.js';
import { CLEAR_ABI } from '../../lib/abis.js';

export class ClearinghouseContract extends Contract<IClearinghouse> {
  public constructor(
    args: Pick<ContractConstructorArgs, 'publicClient' | 'walletClient'>
  ) {
    super({ ...args, address: CLEAR_ADDRESS, abi: CLEAR_ABI });
  }
}
