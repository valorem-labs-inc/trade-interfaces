import {
  Contract,
  ContractConstructorArgs,
  ISeaport,
} from '../base/contract.js';
import { SEAPORT_ADDRESS } from '../../lib/constants.js';
import { SEAPORT_V1_5_ABI } from '../../lib/abis.js';

export class SeaportContract extends Contract<ISeaport> {
  public constructor(
    args: Pick<ContractConstructorArgs, 'publicClient' | 'walletClient'>
  ) {
    super({ ...args, address: SEAPORT_ADDRESS, abi: SEAPORT_V1_5_ABI });
  }
}
