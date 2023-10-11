import {
  Address,
  bytesToBigInt,
  encodeAbiParameters,
  keccak256,
  pad,
  sliceHex,
  toBytes,
} from 'viem';
import { Trader } from './base/trader';
import { ClearinghouseContract } from './contracts/clearinghouse';

export interface OptionType {
  underlyingAsset: Address;
  underlyingAmount: bigint;
  exerciseAsset: Address;
  exerciseAmount: bigint;
  exerciseTimestamp: number;
  expiryTimestamp: number;
}

export class Option {
  public exerciseAsset: Address;
  public underlyingAsset: Address;
  public exerciseAmount: bigint;
  public underlyingAmount: bigint;
  public exerciseTimestamp: number;
  public expiryTimestamp: number;

  private _exists: boolean | undefined;

  constructor(args: OptionType) {
    this.exerciseAsset = args.exerciseAsset;
    this.underlyingAsset = args.underlyingAsset;
    this.exerciseAmount = args.exerciseAmount;
    this.underlyingAmount = args.underlyingAmount;
    this.exerciseTimestamp = args.exerciseTimestamp;
    this.expiryTimestamp = args.expiryTimestamp;
  }

  public get id() {
    const asBytes20 = toBytes(sliceHex(this.hashedParams, 0, 20), { size: 20 });
    const padded = pad(asBytes20, { dir: 'left', size: 32 });
    return bytesToBigInt(padded) << BigInt(96);
  }

  public async optionTypeExists(clearinghouse: ClearinghouseContract) {
    return (this._exists ??= (await this.tokenType(clearinghouse)) !== 0);
  }

  public async tokenType(clearinghouse: ClearinghouseContract) {
    return await clearinghouse.read.tokenType([this.id]);
  }

  public async createOptionType(
    trader: Trader,
    clearinghouse: ClearinghouseContract
  ) {
    console.log(
      `Initializing new OptionType with Clearinghouse. ID:${this.id.toString()}`
    );
    // prepare tx
    const { request } = await clearinghouse.simulate.newOptionType([
      this.underlyingAsset,
      this.underlyingAmount,
      this.exerciseAsset,
      this.exerciseAmount,
      this.exerciseTimestamp,
      this.expiryTimestamp,
    ]);
    // send tx
    const receipt = await trader.executeTransaction(request);
    // check result
    if (receipt.status === 'success') {
      console.log(
        `Successfully created new option type. txHash: ${receipt.transactionHash}`
      );
    }
  }

  private get hashedParams() {
    const encoded = encodeAbiParameters(
      [
        { type: 'address', name: 'underlyingAsset' },
        { type: 'uint96', name: 'underlyingAmount' },
        { type: 'address', name: 'exerciseAsset' },
        { type: 'uint96', name: 'exerciseAmount' },
        { type: 'uint40', name: 'exerciseTimestamp' },
        { type: 'uint40', name: 'expiryTimestamp' },
      ],
      [
        this.underlyingAsset,
        this.underlyingAmount,
        this.exerciseAsset,
        this.exerciseAmount,
        this.exerciseTimestamp,
        this.expiryTimestamp,
      ]
    );
    return keccak256(encoded);
  }
}
