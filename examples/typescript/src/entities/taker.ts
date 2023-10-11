import { Action, QuoteRequest } from '../../gen/valorem/trade/v1/rfq_pb.js';
import { Trader, TraderConstructorArgs } from './base/trader.js';
import { ParsedQuoteResponse, toH160, toH256 } from '../utils/index.js';
import { ItemType } from '../../gen/valorem/trade/v1/seaport_pb.js';
import { CLEAR_ADDRESS, nullBytes32 } from '../lib/constants.js';
import { SeaportContract } from './contracts/seaport.js';

export class Taker extends Trader {
  public constructor(args: TraderConstructorArgs) {
    super(args);
  }

  public createQuoteRequest({
    optionId,
    quantityToBuy,
  }: {
    optionId: bigint;
    quantityToBuy: number;
  }) {
    return new QuoteRequest({
      takerAddress: toH160(this.account.address),
      itemType: ItemType.ERC1155,
      tokenAddress: toH160(CLEAR_ADDRESS),
      identifierOrCriteria: toH256(optionId),
      amount: toH256(quantityToBuy),
      action: Action.BUY,
    });
  }

  public async acceptQuote({
    quote,
    seaport,
  }: {
    quote: ParsedQuoteResponse;
    seaport: SeaportContract;
  }) {
    // prepare tx
    const { parameters, signature } = quote.order;
    const { request } = await seaport.simulate.fulfillOrder([
      { parameters, signature },
      nullBytes32,
    ]);
    // send tx
    const receipt = await this.executeTransaction(request);
    // check result
    if (receipt.status === 'success') {
      console.log('Successfully fulfilled RFQ.');
    }
  }
}
