use ethers::abi::AbiEncode;
use ethers::prelude::{Address, Bytes, Signature, U256};
use valorem_trade_interfaces::bindings;
use valorem_trade_interfaces::grpc_codegen::H256;

// Transform the gRPC details into an ethers-rs Order structure so we can call
// the on-chain seaport contract.
// Note: Even though we have all the disassembled parameters the order has been
//       pre-signed by the Maker, so if we change anything the signature will not
//       match.
pub fn transform_to_seaport_order(
    signed_order: &valorem_trade_interfaces::grpc_codegen::SignedOrder,
    offer_parameters: valorem_trade_interfaces::grpc_codegen::Order,
) -> bindings::seaport::Order {
    let signature_bytes: Signature = signed_order.signature.clone().unwrap().into();
    let signature = Bytes::from(signature_bytes.to_vec());

    let mut offer = Vec::<bindings::seaport::OfferItem>::new();
    for offer_item in offer_parameters.offer {
        offer.push(bindings::seaport::OfferItem {
            item_type: offer_item.item_type as u8,
            token: Address::from(offer_item.token.unwrap()),
            identifier_or_criteria: U256::from(
                offer_item.identifier_or_criteria.unwrap_or_default(),
            ),
            start_amount: U256::from(offer_item.start_amount.unwrap()),
            end_amount: U256::from(offer_item.end_amount.unwrap()),
        })
    }

    let mut consideration = Vec::<bindings::seaport::ConsiderationItem>::new();
    for consideration_item in offer_parameters.consideration {
        consideration.push(bindings::seaport::ConsiderationItem {
            item_type: consideration_item.item_type as u8,
            token: Address::from(consideration_item.token.unwrap_or_default()),
            identifier_or_criteria: U256::from(
                consideration_item
                    .identifier_or_criteria
                    .unwrap_or_default(),
            ),
            start_amount: U256::from(consideration_item.start_amount.unwrap()),
            end_amount: U256::from(consideration_item.end_amount.unwrap()),
            recipient: Address::from(consideration_item.recipient.unwrap()),
        })
    }

    let total_original_consideration_items = U256::from(consideration.len());

    let mut zone_hash: [u8; 32] = Default::default();
    match offer_parameters.zone_hash {
        Some(zone_hash_param) if zone_hash_param != H256::default() => {
            // We need to transform the H256 into a U256 in order for the encode into u8 to work
            // as we expect.
            zone_hash.copy_from_slice(U256::from(zone_hash_param).encode().as_slice());
        }
        _ => zone_hash.fill(0),
    }

    let mut conduit_key: [u8; 32] = Default::default();
    match offer_parameters.conduit_key {
        Some(conduit_key_param) if conduit_key_param != H256::default() => {
            // We need to transform the H256 into a U256 in order for the encode into u8 to work
            // as we expect.
            conduit_key.copy_from_slice(U256::from(conduit_key_param).encode().as_slice());
        }
        _ => conduit_key.fill(0),
    }

    let order_parameters = bindings::seaport::OrderParameters {
        offerer: Address::from(offer_parameters.offerer.unwrap()),
        zone: Address::from(offer_parameters.zone.unwrap_or_default()),
        offer,
        consideration,
        order_type: offer_parameters.order_type as u8,
        start_time: U256::from(offer_parameters.start_time.unwrap()),
        end_time: U256::from(offer_parameters.end_time.unwrap()),
        zone_hash,
        salt: U256::from(offer_parameters.salt.unwrap()),
        conduit_key,
        total_original_consideration_items,
    };

    bindings::seaport::Order {
        parameters: order_parameters,
        signature,
    }
}
