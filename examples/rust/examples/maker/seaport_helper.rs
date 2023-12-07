use ethers::abi::{AbiEncode, RawLog};
use ethers::prelude::{
    Address, EthLogDecode, JsonRpcClient, LocalWallet, Middleware, Provider, SignerMiddleware, U256,
};
use ethers::utils::keccak256;
use log::{info, warn};
use std::{ops::Mul, sync::Arc};
use valorem_trade_interfaces::{
    bindings,
    grpc_codegen::{EthSignature, Order, QuoteRequest, SignedOrder, H256},
};

pub async fn sign_order<P: JsonRpcClient + 'static>(
    signer: &SignerMiddleware<Arc<Provider<P>>, LocalWallet>,
    order_parameters: Order,
    seaport: &bindings::seaport::Seaport<Provider<P>>,
) -> Option<SignedOrder> {
    // As we are going to be returning an Order, we clone the order parameters here, so we can
    // then use them in the order and avoid the `as_ref` and `clone` calls throughout the
    // transformation code (this has no performance impact, just reads a little better).
    let order_parameters_copy = order_parameters.clone();

    // In order to sign the seaport order, we firstly transform the OrderParameters
    // into the ethers equivalents as we need to call the Seaport contract in order to get the
    // order hash.
    let mut offer = Vec::<valorem_trade_interfaces::bindings::seaport::OfferItem>::new();
    for offer_item in order_parameters.offer {
        offer.push(bindings::seaport::OfferItem {
            item_type: offer_item.item_type as u8,
            token: Address::from(offer_item.token.unwrap_or_default()),
            identifier_or_criteria: U256::from(
                offer_item.identifier_or_criteria.unwrap_or_default(),
            ),
            start_amount: U256::from(offer_item.start_amount.unwrap_or_default()),
            end_amount: U256::from(offer_item.end_amount.unwrap_or_default()),
        });
    }

    let mut consideration = Vec::<bindings::seaport::ConsiderationItem>::new();
    for consideration_item in order_parameters.consideration {
        consideration.push(bindings::seaport::ConsiderationItem {
            item_type: consideration_item.item_type as u8,
            token: Address::from(consideration_item.token.unwrap_or_default()),
            identifier_or_criteria: U256::from(
                consideration_item
                    .identifier_or_criteria
                    .unwrap_or_default(),
            ),
            start_amount: U256::from(consideration_item.start_amount.unwrap_or_default()),
            end_amount: U256::from(consideration_item.end_amount.unwrap_or_default()),
            recipient: Address::from(consideration_item.recipient.unwrap_or_default()),
        });
    }

    let mut zone_hash: [u8; 32] = Default::default();
    match order_parameters.zone_hash {
        Some(zone_hash_param) if zone_hash_param != H256::default() => {
            // We need to transform the H256 into a U256 in order for the encode into u8 to work
            // as we expect.
            zone_hash.copy_from_slice(U256::from(zone_hash_param).encode().as_slice());
        }
        _ => zone_hash.fill(0),
    }

    let mut conduit_key: [u8; 32] = Default::default();
    match order_parameters.conduit_key {
        Some(conduit_key_param) if conduit_key_param != H256::default() => {
            // We need to transform the H256 into a U256 in order for the encode into u8 to work
            // as we expect.
            conduit_key.copy_from_slice(U256::from(conduit_key_param).encode().as_slice());
        }
        _ => conduit_key.fill(0),
    }

    let counter = match seaport.get_counter(signer.address()).await {
        Ok(counter) => counter,
        Err(error) => {
            warn!("Unable to get the on-chain counter from Seaport. Reported error {error:?}");
            return None;
        }
    };

    let order_components = bindings::seaport::OrderComponents {
        offerer: Address::from(order_parameters.offerer.unwrap()),
        zone: Address::from(order_parameters.zone.unwrap_or_default()),
        offer,
        consideration,
        order_type: order_parameters.order_type as u8,
        start_time: U256::from(order_parameters.start_time.unwrap()),
        end_time: U256::from(order_parameters.end_time.unwrap()),
        zone_hash,
        salt: U256::from(order_parameters.salt.unwrap()),
        conduit_key,
        counter,
    };

    // Construct the required signature, this was taken from the Seaport tests:
    // https://github.com/ProjectOpenSea/seaport/blob/main/test/foundry/utils/BaseConsiderationTest.sol#L208
    let mut encoded_message = Vec::<u8>::new();
    let order_hash = match seaport.get_order_hash(order_components).call().await {
        Ok(order_hash) => order_hash,
        Err(error) => {
            warn!("Unable to fetch the order hash for the order from the Seaport contract. Reported error: {error:?}");
            return None;
        }
    };
    let (_, domain_separator, _) = match seaport.information().call().await {
        Ok(seaport_information) => seaport_information,
        Err(error) => {
            warn!("Unable to retrieve on-chain Seaport information. Reported error: {error:?}");
            return None;
        }
    };

    // bytes2(0x1901)
    for byte in &[25u8, 1u8] {
        encoded_message.push(*byte);
    }

    for byte in &domain_separator {
        encoded_message.push(*byte);
    }

    for byte in &order_hash {
        encoded_message.push(*byte);
    }

    let hash = keccak256(encoded_message.as_slice());
    let signature = signer
        .signer()
        .sign_hash(ethers::types::H256::from(hash))
        .unwrap();

    // We don't want to directly encode v, as this will be encoded as a u64 where leading
    // zeros matter (so it will be included). We know its only 1 byte, therefore only push 1 byte
    // of data so the signature remains 65 bytes on the wire.
    let eth_signature = EthSignature {
        v: vec![signature.v.to_le_bytes()[0]],
        r: signature.r.encode(),
        s: signature.s.encode(),
    };

    Some(SignedOrder {
        parameters: Some(order_parameters_copy),
        signature: Some(eth_signature),
    })
}

// This function will call "write" on the SettlementEngine contract for the Option Type
// and start_amount given within the RFQ
pub async fn write_option<P: JsonRpcClient + 'static>(
    request_for_quote: &QuoteRequest,
    settlement_engine: &bindings::valorem_clear::SettlementEngine<Provider<P>>,
    signer: &SignerMiddleware<Arc<Provider<P>>, LocalWallet>,
) -> Option<(U256, U256)> {
    let option_type: U256 = request_for_quote
        .identifier_or_criteria
        .as_ref()
        .unwrap()
        .clone()
        .into();
    let amount: U256 = request_for_quote.amount.as_ref().unwrap().clone().into();

    // Take gas estimation out of the equation which can be dicey on the Arbitrum testnet.
    // todo - this is true for now, in the future we should check the chain id
    let gas = U256::from(500000u64);
    let gas_price = U256::from(200).mul(U256::exp10(8usize));

    let mut write_tx = settlement_engine.write(option_type, amount.as_u128()).tx;
    write_tx.set_gas(gas);
    write_tx.set_gas_price(gas_price);
    let pending_tx = match signer.send_transaction(write_tx, None).await {
        Ok(pending_tx) => pending_tx,
        Err(err) => {
            warn!("WriteTxError: Reported error {err:?}");
            warn!("WriteTxError: Unable to continue creation of offer. Failed to call write with Option Type {option_type:?}.");
            warn!("WriteTxError: Returning no offer instead.");
            return None;
        }
    };

    let receipt = match pending_tx.await {
        Ok(Some(receipt)) => receipt,
        Ok(None) => {
            warn!("WritePendingTxError: Did not get a pending transaction returned. This is bad since we made state changing call.");
            warn!("WritePendingTxError: Unable to continue creation of offer.");
            warn!("WritePendingTxError: Returning no offer instead.");
            return None;
        }
        Err(err) => {
            warn!("WritePendingTxError: Reported error {err:?}");
            warn!("WritePendingTxError: Unable to continue creation of offer.");
            warn!("WritePendingTxError: Returning no offer instead.");
            return None;
        }
    };

    // Fetch the logs and get the required option_id. Since we don't get the return data via the
    // tx we can either fetch the trace for the tx and decode the output, or we can simply
    // fetch the tx, lookup the logs it generated and fetch the event which has these ids.
    // We choose the later here we know these RPCs will always work, `debug_traceTransaction`
    // requires node cooperation.
    let mut option_id = U256::default();
    let mut claim_id = U256::default();
    for log_entry in receipt.logs {
        let topics = log_entry.topics.clone();
        let data = log_entry.data.to_vec();

        let event = if let Ok(log) =
            bindings::valorem_clear::SettlementEngineEvents::decode_log(&RawLog { topics, data })
        {
            log
        } else {
            continue;
        };

        if let bindings::valorem_clear::SettlementEngineEvents::OptionsWrittenFilter(event) = event
        {
            info!(
                "Successfully written {:?} options. Option Id {:?}. Claim Id {:?}.",
                event.amount, event.option_id, event.claim_id
            );
            option_id = event.option_id;
            claim_id = event.claim_id;
        }
    }

    if option_id == U256::default() || claim_id == U256::default() {
        warn!("WriteError: Option Id or Claim Id did not change from the default.");
        warn!("WriteError: Option Id {option_id:?}. Claim Id {claim_id:?}.");
        warn!("WriteError: Unable to continue creation of offer.");
        warn!("WriteError: Returning no offer instead.");
        return None;
    }

    Some((option_id, claim_id))
}
