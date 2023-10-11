import {
  H40,
  H96,
  H128,
  H160,
  H256,
} from '../../../gen/valorem/trade/v1/types_pb.js';
import type { Address } from 'viem';
import { getAddress, pad, toHex } from 'viem';

export const fromH40 = (value: H40): bigint => {
  const lo = BigInt(value.lo);
  const hi = BigInt(value.hi) << 8n;

  return lo | hi;
};

export const fromH96 = (value: H96): bigint => {
  const lo = BigInt(value.lo);
  const hi = BigInt(value.hi) << 32n;

  return lo | hi;
};

export const fromH128 = (value: H128): bigint => {
  const lo = BigInt(value.lo);
  const hi = BigInt(value.hi) << 64n;

  return lo | hi;
};

export const fromH160 = (value: H160): bigint => {
  if (!value.hi) throw new Error('hi is undefined');

  const lo = BigInt(value.lo);
  const hi = fromH128(value.hi) << 32n;

  return lo | hi;
};

export const fromH160ToAddress = (value: H160): Address => {
  const unpadded = fromH160(value);

  return getAddress(pad(toHex(unpadded), { size: 20 }));
};

export const fromH256 = (value: H256): bigint => {
  if (!value.lo) throw new Error('lo is undefined');
  if (!value.hi) throw new Error('hi is undefined');

  const loLo = BigInt(value.lo.lo);
  const loHi = BigInt(value.lo.hi) << 64n;

  const hiLo = BigInt(value.hi.lo) << 128n;
  const hiHi = BigInt(value.hi.hi) << 192n;

  return loLo | loHi | hiLo | hiHi;
};
