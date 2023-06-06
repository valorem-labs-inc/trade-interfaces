import { H128, H160, H256 } from '../gen/types_pb';

export const toH128 = (value: bigint | number | string): H128 => {
    const bn = BigInt(value);
  
    const hi = bn >> BigInt(64);
    const lo = bn & BigInt(0xFFFFFFFFFFFFFFFF);
  
    return new H128({
      hi,
      lo,
    });
};

export const toH160 = (value: bigint | number | string): H160 => {
  const bn = BigInt(value);

  const hi = toH128(bn >> BigInt(32));
  const lo = Number(bn & BigInt(0xFFFFFFFF));

  return new H160({
    hi,
    lo,
  });
};

export const toH256 = (value: bigint | number | string): H256 => {
  const bn = BigInt(value);

  const hi = toH128(bn >> BigInt(128));
  const lo = toH128(bn & BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF'));

  return new H256({
    hi,
    lo,
  });
};