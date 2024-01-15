use crate::create_soft_quote_no_offer;
use crate::fetch_chain_id;
use crate::time_now;
use ethers::prelude::{
    rand::{thread_rng, Rng},
    Address, JsonRpcClient, LocalWallet, Middleware, Provider, SignerMiddleware, U256,
};
use log::{info, warn};
use std::{ops::Mul, sync::Arc};
use valorem_trade_interfaces::{
    bindings, grpc_codegen,
    grpc_codegen::{
        Action, ConsiderationItem, ItemType, OfferItem, Order, OrderType, QuoteRequest,
        SoftQuoteResponse, H256,
    },
};

/// Validate the received soft-quote is not malformed and supported.
pub fn validate_soft_quote(rfq: QuoteRequest) -> Option<QuoteRequest> {
    // Since this is an RFQ there should always be a token_address (settlement contract) and
    // an identifier_or_criteria set.
    if rfq.token_address.is_none() {
        warn!("Received a RFQ with invalid token information. The token_address was None.");
        return None;
    }

    if rfq.identifier_or_criteria.is_none() {
        warn!("Received a RFQ with invalid token information. Identifier or Criteria was None.");
        return None;
    }

    // Amount needs to be non-zero
    if rfq.amount.is_none() {
        warn!("Received a RFQ with an invalid amount. Amount was None.");
        return None;
    } else {
        let amount: U256 = rfq.amount.clone().unwrap().into();
        if amount.is_zero() {
            warn!("Received a RFQ with an invalid amount. Amount was Zero.");
            return None;
        }
    }

    // Action needs to be valid
    let action: Action = rfq.action.into();
    if action != Action::Buy && action != Action::Sell {
        warn!("Received a RFQ with an invalid action.");
        return None;
    }

    Some(rfq)
}

pub async fn handle_soft_quote_request<P: JsonRpcClient + 'static>(
    request_for_quote: QuoteRequest,
    settlement_engine: &bindings::valorem_clear::SettlementEngine<Provider<P>>,
    signer: &SignerMiddleware<Arc<Provider<P>>, LocalWallet>,
    seaport: &bindings::seaport::Seaport<Provider<P>>,
    usdc_address: Address,
) -> Option<SoftQuoteResponse> {
    // Return an offer with an hardcoded price in USDC.
    let fee = 10;

    info!(
        "Soft Quote received. Returning quote with {:?} as price.",
        U256::from(fee).mul(U256::exp10(6usize))
    );

    let request_action: Action = request_for_quote.action.into();
    let (offered_item, consideration_item) = match request_action {
        Action::Buy => {
            // Option we are offering
            let option = OfferItem {
                item_type: i32::from(ItemType::Erc1155 as u8),
                token: Some(settlement_engine.address().into()),
                identifier_or_criteria: request_for_quote.identifier_or_criteria,
                start_amount: request_for_quote.amount.clone(),
                end_amount: request_for_quote.amount.clone(),
            };

            // Price we want for the option
            let price = ConsiderationItem {
                item_type: i32::from(ItemType::Erc20 as u8),
                token: Some(usdc_address.into()),
                identifier_or_criteria: None,
                start_amount: Some(U256::from(fee).mul(U256::exp10(6usize)).into()),
                end_amount: Some(U256::from(fee).mul(U256::exp10(6usize)).into()),
                recipient: Some(signer.address().into()),
            };

            (option, price)
        }
        Action::Sell => {
            let option_id = U256::from(request_for_quote.identifier_or_criteria.clone().unwrap());
            info!("Handling Sell Order for Option Id {:?}", option_id);

            // We are offering the following price for the given option
            let price = OfferItem {
                item_type: i32::from(ItemType::Erc20 as u8),
                token: Some(usdc_address.into()),
                identifier_or_criteria: None,
                start_amount: Some(U256::from(fee).mul(U256::exp10(6usize)).into()),
                end_amount: Some(U256::from(fee).mul(U256::exp10(6usize)).into()),
            };

            // The option we want in return
            let option = ConsiderationItem {
                item_type: i32::from(ItemType::Erc1155 as u8),
                token: Some(settlement_engine.address().into()),
                identifier_or_criteria: Some(option_id.into()),
                start_amount: request_for_quote.amount.clone(),
                end_amount: request_for_quote.amount.clone(),
                recipient: Some(signer.address().into()),
            };

            (price, option)
        }
        _ => {
            info!("Received invalid action {:?} from the RFQ, returning no offer", request_action);
            let no_offer = create_soft_quote_no_offer(&request_for_quote, signer);
            return Some(no_offer);
        }
    };

    // Offer is only valid for 30 minutes
    let now: H256 = U256::from(time_now()).into();
    let now_plus_30_minutes: H256 = (U256::from(time_now()) + U256::from(1200u64)).into();

    // Reference https://docs.opensea.io/reference/seaport-overview
    //           https://docs.opensea.io/reference/create-an-offer
    // Arbitrary source of entropy for the order
    let salt = U256::from(thread_rng().gen::<u128>());

    // Valorem have a domain tag: 60DD32CF
    let domain_tag = U256::from_str_radix("60DD32CF", 16_u32).unwrap();
    let mask = U256::from(2_u8)
        .pow(U256::from(32))
        .saturating_sub(U256::one());
    let salt = (salt & !mask) + domain_tag;

    let parameters = Order {
        zone: None,
        zone_hash: None,
        conduit_key: None,

        // OpenSea: Must be open order
        // Note: We use a FULL fill here as we don't want to allow partial fills of the order
        //  this can change based on MM strategy
        order_type: i32::from(OrderType::FullOpen as u8),

        offerer: Some(signer.address().into()),
        offer: vec![offered_item],
        start_time: Some(now),
        end_time: Some(now_plus_30_minutes),
        consideration: vec![consideration_item],
        salt: Some(salt.into()),
    };

    let chain_id = fetch_chain_id(&signer.provider()).await?;

    Some(SoftQuoteResponse {
        ulid: request_for_quote.ulid,
        maker_address: Some(grpc_codegen::H160::from(signer.address())),
        order: Some(parameters),
        chain_id: Some(grpc_codegen::H256::from(chain_id)),
        seaport_address: Some(grpc_codegen::H160::from(seaport.address())),
    })
}
