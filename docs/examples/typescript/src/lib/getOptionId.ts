import { BigNumber, ethers } from 'ethers';

export interface OptionType {
  underlyingAsset: string;
  underlyingAmount: BigNumber;
  exerciseAsset: string;
  exerciseAmount: BigNumber;
  exerciseTimestamp: number;
  expiryTimestamp: number;
}

function getHashedOptionParams(option: Partial<OptionType>) {
  try {
    const encoded = ethers.utils.defaultAbiCoder.encode(
      ['address', 'uint96', 'address', 'uint96', 'uint40', 'uint40'],
      [
        option.underlyingAsset,
        option.underlyingAmount ?? BigNumber.from(0),
        option.exerciseAsset,
        option.exerciseAmount ?? BigNumber.from(0),
        option.exerciseTimestamp ?? BigNumber.from(0),
        option.expiryTimestamp ?? BigNumber.from(0),
      ]
    );

    return ethers.utils.keccak256(encoded);
  } catch (error) {
    return undefined;
  }
}

// this utility emulates the Contract's newOptionType() function
// and returns the optionId
export function getOptionId(option: OptionType): BigNumber {
  try {
    const hashedParams = getHashedOptionParams(option); // hashedParams.length = 66

    // uint160
    // yes, in the contracts, optionID is shifted left and this shifts right... I have no idea :shrug:
    const optionKey = BigNumber.from(hashedParams).shr(96); // optionKey.toHexString().toString().length = 42

    // cast to uint256
    const optionId = BigNumber.from(optionKey.toHexString().padEnd(66, '0')); // optionId.toHexString().toString().length = 66

    return optionId;
  } catch (error) {
    return BigNumber.from(0);
  }
}