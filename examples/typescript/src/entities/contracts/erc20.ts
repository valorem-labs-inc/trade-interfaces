import { Contract, ContractConstructorArgs, IERC20 } from '../base/contract.js';
import { erc20ABI } from '@wagmi/core';

export class ERC20Contract extends Contract<IERC20> {
  private _symbol?: string;
  private _decimals?: number;

  public constructor(
    args: Pick<
      ContractConstructorArgs,
      'address' | 'publicClient' | 'walletClient'
    >
  ) {
    super({ ...args, abi: erc20ABI });
    this.getSymbol();
    this.getDecimals();
  }

  public get symbol() {
    if (!this._symbol) throw new Error('Symbol not set');
    return this._symbol;
  }

  public get decimals() {
    if (!this._decimals) throw new Error('Decimals not set');
    return this._decimals;
  }

  private async getSymbol(): Promise<string> {
    if (!this._symbol) {
      this._symbol = await this.read.symbol();
    }
    return this._symbol;
  }

  private async getDecimals(): Promise<number> {
    if (!this._decimals) {
      this._decimals = await this.read.decimals();
    }
    return this._decimals;
  }
}
