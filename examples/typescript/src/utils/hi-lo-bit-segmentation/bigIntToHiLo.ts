import {
  H40,
  H96,
  H128,
  H160,
  H256,
} from '../../../gen/valorem/trade/v1/types_pb.js';

type BigIntable = string | number | bigint | boolean;

export const toH40 = (value: BigIntable): H40 => {
  const bn = BigInt(value);

  const hi = Number(bn >> 32n);
  const lo = Number(bn & 0xffn);

  return new H40({
    hi,
    lo,
  });
};

export const toH96 = (value: BigIntable): H96 => {
  const bn = BigInt(value);

  const hi = bn >> 32n;
  const lo = Number(bn & 0xffffffffn);

  return new H96({
    hi,
    lo,
  });
};

export const toH128 = (value: BigIntable): H128 => {
  const bn = BigInt(value);

  const hi = bn >> 64n;
  const lo = bn & 0xffffffffffffffffn;

  return new H128({
    hi,
    lo,
  });
};

export const toH160 = (value: BigIntable): H160 => {
  const bn = BigInt(value);

  const hi = toH128(bn >> 32n);
  const lo = Number(bn & 0xffffffffn);

  return new H160({
    hi,
    lo,
  });
};

export const toH256 = (value: BigIntable): H256 => {
  const bn = BigInt(value);

  const hi = toH128(bn >> 128n);
  const lo = toH128(bn & 0xffffffffffffffffffffffffffffffffn);

  return new H256({
    hi,
    lo,
  });
};
