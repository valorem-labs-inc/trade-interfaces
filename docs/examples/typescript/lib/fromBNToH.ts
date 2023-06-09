import type { BigNumberish } from 'ethers';
import { BigNumber } from 'ethers';

import { H40, H96, H128, H160, H256 } from '../../../../gen/quay/types_pb';

export const toH40 = (value: BigNumberish): H40 => {
  const bn = BigNumber.from(value);

  const hi = bn.shr(32).toNumber();
  const lo = bn.and(BigNumber.from('0xFF')).toNumber();

  return new H40({
    hi,
    lo,
  });
};

export const toH96 = (value: BigNumberish): H96 => {
  const bn = BigNumber.from(value);

  const hi = bn.shr(32).toBigInt();
  const lo = bn.and(BigNumber.from('0xFFFFFFFF')).toNumber();

  return new H96({
    hi,
    lo,
  });
};

export const toH128 = (value: BigNumberish): H128 => {
  const bn = BigNumber.from(value);

  const hi = bn.shr(64).toBigInt();
  const lo = bn.and(BigNumber.from('0xFFFFFFFFFFFFFFFF')).toBigInt();

  return new H128({
    hi,
    lo,
  });
};

export const toH160 = (value: BigNumberish): H160 => {
  const bn = BigNumber.from(value);

  const hi = toH128(bn.shr(32));
  const lo = bn.and(BigNumber.from('0xFFFFFFFF')).toNumber();

  return new H160({
    hi,
    lo,
  });
};

export const toH256 = (value: BigNumberish): H256 => {
  const bn = BigNumber.from(value);

  const hi = toH128(bn.shr(128));
  const lo = toH128(
    bn.and(BigNumber.from('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF'))
  );

  return new H256({
    hi,
    lo,
  });
};