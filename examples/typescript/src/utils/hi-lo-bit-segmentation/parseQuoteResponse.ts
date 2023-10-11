import {
  bytesToBigInt,
  bytesToHex,
  pad,
  signatureToHex,
  toHex,
  zeroAddress,
} from 'viem';
import { fromH128, fromH160ToAddress, fromH256 } from './index.js';
import { QuoteResponse } from '../../../gen/valorem/trade/v1/rfq_pb.js';
import { nullBytes32 } from '../../lib/constants.js';

export type ParsedQuoteResponse = ReturnType<typeof parseQuoteResponse>;

export const parseQuoteResponse = (res: QuoteResponse) => {
  if (!res.seaportAddress)
    throw new Error(
      'Invalid response from RFQ server. Missing seaport address.'
    );
  if (!res.order?.parameters)
    throw new Error(
      'Invalid response from RFQ server. Missing order parameters.'
    );
  if (!res.order.signature)
    throw new Error(
      'Invalid response from RFQ server. Missing order signature.'
    );
  if (!res.order.parameters.offerer)
    throw new Error(
      'Invalid response from RFQ server. Missing order params: offerer.'
    );
  if (!res.order.parameters.startTime)
    throw new Error(
      'Invalid response from RFQ server. Missing order params: startTime.'
    );
  if (!res.order.parameters.endTime)
    throw new Error(
      'Invalid response from RFQ server. Missing order params: endTime.'
    );
  if (!res.order.parameters.salt)
    throw new Error(
      'Invalid response from RFQ server. Missing order params: salt.'
    );
  if (!res.ulid)
    throw new Error(
      'Invalid response from RFQ server. Missing order params: ulid.'
    );
  if (!res.makerAddress)
    throw new Error(
      'Invalid response from RFQ server. Missing order params: makerAddress.'
    );

  const { r, s, v } = res.order.signature;

  const parsedQuoteResponse = {
    ulid: fromH128(res.ulid),
    makerAddress: fromH160ToAddress(res.makerAddress),
    chainId: res.chainId ? Number(fromH256(res.chainId).toString()) : undefined,
    seaportAddress: fromH160ToAddress(res.seaportAddress),
    order: {
      signature: signatureToHex({
        r: bytesToHex(r),
        s: bytesToHex(s),
        v: bytesToBigInt(v),
      }),
      parameters: {
        offerer: fromH160ToAddress(res.order.parameters.offerer),
        zone: res.order.parameters.zone
          ? fromH160ToAddress(res.order.parameters.zone)
          : zeroAddress,
        offer: res.order.parameters.offer.map((o) => {
          return {
            itemType: o.itemType,
            token: o.token ? fromH160ToAddress(o.token) : zeroAddress,
            identifierOrCriteria: o.identifierOrCriteria
              ? fromH256(o.identifierOrCriteria)
              : 0n,
            startAmount: o.startAmount ? fromH256(o.startAmount) : 0n,
            endAmount: o.endAmount ? fromH256(o.endAmount) : 0n,
          };
        }),
        consideration: res.order.parameters.consideration.map((c) => {
          return {
            itemType: c.itemType,
            token: c.token ? fromH160ToAddress(c.token) : zeroAddress,
            identifierOrCriteria: c.identifierOrCriteria
              ? fromH256(c.identifierOrCriteria)
              : 0n,
            startAmount: c.startAmount ? fromH256(c.startAmount) : 0n,
            endAmount: c.endAmount ? fromH256(c.endAmount) : 0n,
            recipient: c.recipient
              ? fromH160ToAddress(c.recipient)
              : zeroAddress,
          };
        }),
        totalOriginalConsiderationItems: BigInt(
          res.order.parameters.consideration.length
        ),
        orderType: res.order.parameters.orderType,
        startTime: fromH256(res.order.parameters.startTime),
        endTime: fromH256(res.order.parameters.endTime),
        zoneHash: res.order.parameters.zoneHash
          ? pad(toHex(fromH256(res.order.parameters.zoneHash)), {
              size: 32,
            })
          : nullBytes32,
        salt: fromH256(res.order.parameters.salt),
        conduitKey: res.order.parameters.conduitKey
          ? pad(toHex(fromH256(res.order.parameters.conduitKey)), {
              size: 32,
            })
          : nullBytes32,
      },
    },
  };

  if (!parsedQuoteResponse.order.parameters.consideration[0]) {
    throw new Error('Invalid response from RFQ server. Missing consideration.');
  }

  if (!parsedQuoteResponse.order.parameters.offer[0]) {
    throw new Error('Invalid response from RFQ server. Missing offer.');
  }

  return parsedQuoteResponse;
};
