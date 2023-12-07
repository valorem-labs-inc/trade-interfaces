use crate::create_no_offer;
use crate::fetch_chain_id;
use crate::seaport_helper::sign_order;
use crate::seaport_helper::write_option;
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
        QuoteResponse, H256,
    },
};

/// Validate the received RFQ is not malformed and supported.
pub fn validate_rfq(seaport_address: Address, rfq: QuoteRequest) -> Option<QuoteRequest> {
    // We always expect Valorem to set a ulid therefore if we don't see one, return a no offer.
    if rfq.ulid.is_none() {
        warn!("Received a RFQ without a ULID set. ULID was None.");
        return None;
    }

    // Taker address is completely optional.

    // Item Type needs to be valid and can only be ERC1155 for Valorem (for now)
    let item_type = ItemType::from_i32(rfq.item_type).unwrap_or(ItemType::Native);
    if item_type != ItemType::Erc1155 {
        warn!("Received a RFQ with an invalid ItemType. ItemType was not Erc1155.");
        return None;
    }

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
    if action == Action::Invalid {
        warn!("Received a RFQ with an invalid action. The Action was mapped to Invalid.");
        return None;
    }

    // Check the seaport address is against the one we support.
    if let Some(rfq_seaport_address) = rfq.seaport_address.clone() {
        if seaport_address != rfq_seaport_address.into() {
            warn!("Received an RFQ against a non-supported seaport address.");
            return None;
        }
    } else {
        warn!("Did not receive a seaport address in the RFQ.");
        return None;
    }

    Some(rfq)
}

pub async fn handle_rfq_request<P: JsonRpcClient + 'static>(
    request_for_quote: QuoteRequest,
    settlement_engine: &bindings::valorem_clear::SettlementEngine<Provider<P>>,
    signer: &SignerMiddleware<Arc<Provider<P>>, LocalWallet>,
    seaport: &bindings::seaport::Seaport<Provider<P>>,
    usdc_address: Address,
) -> Option<QuoteResponse> {
    // Return an offer with an hardcoded price in USDC.
    let fee = 10;

    info!(
        "RFQ received. Returning offer with {:?} as price.",
        U256::from(fee).mul(U256::exp10(6usize))
    );

    let request_action: Action = request_for_quote.action.into();
    let (offered_item, consideration_item) = match request_action {
        Action::Buy => {
            info!(
                "Handling Buy Order for Option Type {:?}",
                U256::from(request_for_quote.identifier_or_criteria.clone().unwrap())
            );
            let (option_id, _claim_id) =
                match write_option(&request_for_quote, settlement_engine, signer).await {
                    Some((option_id, claim_id)) => (option_id, claim_id),
                    None => {
                        // This signals an error, so we write no offer instead.
                        let no_offer = create_no_offer(&request_for_quote, signer);
                        return Some(no_offer);
                    }
                };

            // Option we are offering
            let option = OfferItem {
                item_type: i32::from(ItemType::Erc1155 as u8),
                token: Some(settlement_engine.address().into()),
                identifier_or_criteria: Some(option_id.into()),
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
        Action::Invalid => {
            info!("Received invalid action from the RFQ, returning no offer");
            let no_offer = create_no_offer(&request_for_quote, signer);
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

    let signed_order = sign_order(signer, parameters, seaport).await?;
    let chain_id = fetch_chain_id(&signer.provider()).await?;

    Some(QuoteResponse {
        ulid: request_for_quote.ulid,
        maker_address: Some(grpc_codegen::H160::from(signer.address())),
        order: Some(signed_order),
        chain_id: Some(grpc_codegen::H256::from(chain_id)),
        seaport_address: Some(grpc_codegen::H160::from(seaport.address())),
    })
}
