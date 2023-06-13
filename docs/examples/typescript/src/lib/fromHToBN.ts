import { BigNumber } from 'ethers';

import type { H40, H96, H128, H160, H256 } from '../../../../gen/trade/types_pb';

export const fromH40 = (value: H40): BigNumber => {
  const lo = BigNumber.from(value.lo);
  const hi = BigNumber.from(value.hi).shl(8);

  const result = lo.or(hi);
  return result;
};

export const fromH96 = (value: H96): BigNumber => {
  const lo = BigNumber.from(value.lo);
  const hi = BigNumber.from(value.hi).shl(32);

  const result = lo.or(hi);
  return result;
};

export const fromH128 = (value: H128): BigNumber => {
  const lo = BigNumber.from(value.lo);
  const hi = BigNumber.from(value.hi).shl(64);

  const result = lo.or(hi);
  return result;
};

export const fromH160 = (value: H160): BigNumber => {
  const lo = BigNumber.from(value.lo);
  const hi = fromH128(value.hi!).shl(32);

  const result = lo.or(hi);
  return result;
};

export const fromH256 = (value: H256): BigNumber => {
  const loLo = BigNumber.from(value.lo?.lo);
  const loHi = BigNumber.from(value.lo?.hi).shl(64);

  const hiLo = BigNumber.from(value.hi?.lo).shl(128);
  const hiHi = BigNumber.from(value.hi?.hi).shl(192);

  const result = loLo.or(loHi).or(hiLo).or(hiHi);
  return result;
};