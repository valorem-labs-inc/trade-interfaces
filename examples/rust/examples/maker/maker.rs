use crate::settings::Settings;
use ethers::abi::{AbiEncode, RawLog};
use ethers::prelude::{
    rand::{thread_rng, Rng},
    Address, EthLogDecode, Http, Ipc, JsonRpcClient, LocalWallet, Middleware, Provider, Signer, SignerMiddleware, Ws,
    U256,
};
use ethers::utils::keccak256;
use http::Uri;
use log::{error, info, warn};
use siwe::{TimeStamp, Version};
use std::time::{SystemTime, UNIX_EPOCH};
use std::{env, ops::Mul, process::exit, sync::Arc, time::Duration};
use time::OffsetDateTime;
use tokio::{sync::mpsc, time::sleep};
use tonic::transport::{Channel, ClientTlsConfig};
use valorem_trade_interfaces::utils::session_interceptor::SessionInterceptor;
use valorem_trade_interfaces::{
    bindings, grpc_codegen,
    grpc_codegen::{
        auth_client::AuthClient, rfq_client::RfqClient, Action, ConsiderationItem, Empty, EthSignature, ItemType,
        OfferItem, Order, OrderType, QuoteRequest, QuoteResponse, SignedOrder, VerifyText, H256,
    },
};

mod settings;

enum EthersProvider {
    HttpProvider(Provider<Http>),
    WsProvider(Provider<Ws>),
    IpcProvider(Provider<Ipc>),
}

const SESSION_COOKIE_KEY: &str = "set-cookie";

const TOS_ACCEPTANCE: &str = "I accept the Valorem Terms of Service at https://app.valorem.xyz/tos and Privacy Policy at https://app.valorem.xyz/privacy";

/// An example Market Maker (MM) client interface to Valorem.
///
/// The Market Maker will receive Request For Quote (RFQ) from the Valorem server formatted as
/// `QuoteRequest` and the MM needs to respond with `QuoteResponse`.
#[tokio::main]
async fn main() {
    // If no logging options are given, by default set global logging to warn and the maker to info.
    let value = env::var("RUST_LOG").unwrap_or(String::from("warn,maker=info"));
    env::set_var("RUST_LOG", value);

    // Initialise a coloured timed logger
    pretty_env_logger::init_timed();

    let args: Vec<String> = env::args().skip(1).collect();
    if args.len() != 1 {
        eprintln!("Unexpected command line arguments. Received {:?}", args);
        eprintln!("Usage: maker <settings_file>");
        exit(1);
    }

    let settings = Settings::load(&args[0]);

    loop {
        let provider = connect_to_node_provider(settings.node_endpoint.clone()).await;

        match provider {
            EthersProvider::HttpProvider(provider) => {
                run(Arc::new(provider), settings.clone()).await;
            }
            EthersProvider::WsProvider(provider) => {
                run(Arc::new(provider), settings.clone()).await;
            }
            EthersProvider::IpcProvider(provider) => {
                run(Arc::new(provider), settings.clone()).await;
            }
        }

        // We never expect the run function above to end, however it can primarily due to the connection to
        // Valorem being closed. Sleep for a set period of time in case there are other issues at play
        // (i.e. Valorem down) before retrying to connect.
        warn!("Reconnection Event: Returned from the main run function, reconnecting to Valorem");
        sleep(Duration::from_secs(10)).await;
    }
}

// Helper function to connect to a node provider.
async fn connect_to_node_provider(node_endpoint: String) -> EthersProvider {
    if node_endpoint.starts_with("http") {
        let provider = match Provider::<Http>::try_from(node_endpoint) {
            Ok(connection) => {
                // Decrease the ethers polling time from the default of 7 seconds to 1 second.
                connection.interval(Duration::from_secs(1))
            }
            Err(connection_error) => {
                // If we cannot connect to our provider, we are in trouble. Panic out instead of
                // trying to implement reconnection logic as most of the time the node will be local.
                panic!("HTTP connection error: {connection_error:?}")
            }
        };

        EthersProvider::HttpProvider(provider)
    } else if node_endpoint.starts_with("ws") {
        let provider = match Ws::connect(node_endpoint).await {
            Ok(connection) => {
                // Decrease the ethers polling time from the default of 7 seconds to 1 second.
                Provider::<Ws>::new(connection).interval(Duration::from_secs(1))
            }
            Err(connection_error) => {
                // If we cannot connect to our provider, we are in trouble. Panic out instead of
                // trying to implement reconnection logic as most of the time the node will be local.
                panic!("Websocket connection error: {connection_error:?}")
            }
        };

        EthersProvider::WsProvider(provider)
    } else {
        let provider = match Provider::connect_ipc(node_endpoint).await {
            Ok(connection) => {
                // Decrease the ethers polling time from the default of 7 seconds to 1 second.
                connection.interval(Duration::from_secs(1))
            }
            Err(connection_error) => {
                // If we cannot connect to our local provider, we are in trouble just panic out instead.
                panic!("IPC connection error: {connection_error:?}")
            }
        };

        EthersProvider::IpcProvider(provider)
    }
}

// Main execution function. This is not expected to return.
async fn run<P: JsonRpcClient + 'static>(provider: Arc<Provider<P>>, settings: Settings) -> Option<()> {
    let session_cookie = setup(
        settings.valorem_endpoint.clone(),
        settings.wallet.clone(),
        settings.tls_config.clone(),
        &provider,
    )
    .await?;

    // Now there is a valid authenticated session, connect to the RFQ stream
    let mut client = RfqClient::with_interceptor(
        Channel::builder(settings.valorem_endpoint.clone())
            .tls_config(settings.tls_config.clone())
            .ok()?
            .http2_keep_alive_interval(Duration::new(75, 0))
            .keep_alive_timeout(Duration::new(10, 0))
            .timeout(Duration::from_secs(10))
            .connect_timeout(Duration::from_secs(10))
            .connect()
            .await
            .ok()?,
        SessionInterceptor { session_cookie },
    );

    // Setup a signer so we can send transactions
    let settlement_engine =
        bindings::valorem_clear::SettlementEngine::new(settings.settlement_contract, Arc::clone(&provider));
    let signer = SignerMiddleware::new_with_provider_chain(Arc::clone(&provider), settings.wallet.clone())
        .await
        .ok()?;

    // Seaport 1.5 contract address
    // Note: We allow the unchecked unwrap here, since this address will always parse correctly.
    let seaport_contract_address = "0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC".parse::<Address>().unwrap();

    let seaport = bindings::seaport::Seaport::new(seaport_contract_address, Arc::clone(&provider));

    // Approve the tokens the example will be using
    if settings.approve_tokens {
        approve_tokens(&provider, &settings, &signer, &settlement_engine, &seaport).await;
    }

    // The gRPC stream might end for a couple of reasons, for example:
    // * There are no clients connected after a RFQ
    // * Infrastructure middle men (like Cloudflare) has killed the connection.
    loop {
        // Setup the stream between us and Valorem which the gRPC connection will use.
        let (tx_quote_response, rx_quote_response) = mpsc::channel::<QuoteResponse>(64);
        let mut quote_stream = client
            .maker(tokio_stream::wrappers::ReceiverStream::new(rx_quote_response))
            .await
            .ok()?
            .into_inner();

        info!("Ready for RFQs from Takers");

        // Now we have received the RFQ request stream - loop until it ends.
        while let Ok(Some(quote)) = quote_stream.message().await {
            // Check the chain-id is valid
            if quote.chain_id.is_none() {
                warn!("Invalid RFQ request was received. No chain-id was given, ignoring the request");
                continue;
            }

            let chain_id: U256 = quote.chain_id.clone().unwrap().into();
            if chain_id != U256::from(421613_u64) {
                warn!("RFQ request was not on the testnet chain. Ignoring the request");
                continue;
            }

            let quote_offer = if validate_rfq(seaport_contract_address, quote.clone()).is_none() {
                // Malformed RFQ return a no-quote
                create_no_offer(&quote, &signer)
            } else {
                handle_rfq_request(quote, &settlement_engine, &signer, &seaport, settings.usdc_address).await
            };

            tx_quote_response.send(quote_offer).await.ok()?;
        }
    }
}

/// Validate the received RFQ is not malformed and supported.
fn validate_rfq(seaport_address: Address, rfq: QuoteRequest) -> Option<QuoteRequest> {
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

async fn handle_rfq_request<P: JsonRpcClient + 'static>(
    request_for_quote: QuoteRequest,
    settlement_engine: &bindings::valorem_clear::SettlementEngine<Provider<P>>,
    signer: &SignerMiddleware<Arc<Provider<P>>, LocalWallet>,
    seaport: &bindings::seaport::Seaport<Provider<P>>,
    usdc_address: Address,
) -> QuoteResponse {
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
            let (option_id, _claim_id) = match write_option(&request_for_quote, settlement_engine, signer).await {
                Some((option_id, claim_id)) => (option_id, claim_id),
                None => {
                    // This signals an error, so we write no offer instead.
                    let no_offer = create_no_offer(&request_for_quote, signer);
                    return no_offer;
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
            return no_offer;
        }
    };

    // Offer is only valid for 30 minutes (based from the block timestamp)
    let block_number = signer.provider().get_block_number().await.unwrap();
    let block_timestamp = signer
        .provider()
        .get_block(block_number)
        .await
        .unwrap()
        .unwrap()
        .timestamp;
    let now: H256 = block_timestamp.into();
    let now_plus_30_minutes: H256 = (block_timestamp + U256::from(1200u64)).into();

    // Reference https://docs.opensea.io/reference/seaport-overview
    //           https://docs.opensea.io/reference/create-an-offer
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
        // Arbitrary source of entropy for the order
        salt: Some(U256::from(thread_rng().gen::<u128>()).into()),
    };

    let signed_order = sign_order(signer, parameters, seaport).await;
    QuoteResponse {
        ulid: request_for_quote.ulid,
        maker_address: Some(grpc_codegen::H160::from(signer.address())),
        order: Some(signed_order),
        chain_id: Some(grpc_codegen::H256::from(signer.provider().get_chainid().await.unwrap())),
        seaport_address: Some(grpc_codegen::H160::from(seaport.address())),
    }
}

async fn sign_order<P: JsonRpcClient + 'static>(
    signer: &SignerMiddleware<Arc<Provider<P>>, LocalWallet>,
    order_parameters: Order,
    seaport: &bindings::seaport::Seaport<Provider<P>>,
) -> SignedOrder {
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
            identifier_or_criteria: U256::from(offer_item.identifier_or_criteria.unwrap_or_default()),
            start_amount: U256::from(offer_item.start_amount.unwrap_or_default()),
            end_amount: U256::from(offer_item.end_amount.unwrap_or_default()),
        });
    }

    let mut consideration = Vec::<bindings::seaport::ConsiderationItem>::new();
    for consideration_item in order_parameters.consideration {
        consideration.push(bindings::seaport::ConsiderationItem {
            item_type: consideration_item.item_type as u8,
            token: Address::from(consideration_item.token.unwrap_or_default()),
            identifier_or_criteria: U256::from(consideration_item.identifier_or_criteria.unwrap_or_default()),
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

    let counter = seaport.get_counter(signer.address()).await.unwrap();

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
    let order_hash = seaport.get_order_hash(order_components).call().await.unwrap();
    let (_, domain_separator, _) = seaport.information().call().await.unwrap();

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
    let signature = signer.signer().sign_hash(ethers::types::H256::from(hash)).unwrap();

    // We don't want to directly encode v, as this will be encoded as a u64 where leading
    // zeros matter (so it will be included). We know its only 1 byte, therefore only push 1 byte
    // of data so the signature remains 65 bytes on the wire.
    let eth_signature = EthSignature {
        v: vec![signature.v.to_le_bytes()[0]],
        r: signature.r.encode(),
        s: signature.s.encode(),
    };

    SignedOrder {
        parameters: Some(order_parameters_copy),
        signature: Some(eth_signature),
    }
}

// This function will call "write" on the SettlementEngine contract for the Option Type
// and start_amount given within the RFQ
async fn write_option<P: JsonRpcClient + 'static>(
    request_for_quote: &QuoteRequest,
    settlement_engine: &bindings::valorem_clear::SettlementEngine<Provider<P>>,
    signer: &SignerMiddleware<Arc<Provider<P>>, LocalWallet>,
) -> std::option::Option<(U256, U256)> {
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

        let event =
            if let Ok(log) = bindings::valorem_clear::SettlementEngineEvents::decode_log(&RawLog { topics, data }) {
                log
            } else {
                continue;
            };

        if let bindings::valorem_clear::SettlementEngineEvents::OptionsWrittenFilter(event) = event {
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

// Create the "No offer" response data
fn create_no_offer<P: JsonRpcClient + 'static>(
    request_for_quote: &QuoteRequest,
    signer: &SignerMiddleware<Arc<Provider<P>>, LocalWallet>,
) -> QuoteResponse {
    QuoteResponse {
        ulid: request_for_quote.ulid.clone(),
        maker_address: Some(grpc_codegen::H160::from(signer.address())),
        order: None,
        chain_id: request_for_quote.chain_id.clone(),
        seaport_address: request_for_quote.seaport_address.clone(),
    }
}

// Connect and setup a valid session
async fn setup<P: JsonRpcClient + 'static>(
    valorem_uri: Uri,
    wallet: LocalWallet,
    tls_config: ClientTlsConfig,
    provider: &Arc<Provider<P>>,
) -> Option<String> {
    // Connect and authenticate with Valorem
    let mut client: AuthClient<Channel> = AuthClient::new(
        Channel::builder(valorem_uri.clone())
            .tls_config(tls_config.clone())
            .ok()?
            .http2_keep_alive_interval(Duration::new(75, 0))
            .keep_alive_timeout(Duration::new(10, 0))
            .timeout(Duration::from_secs(10))
            .connect_timeout(Duration::from_secs(10))
            .connect()
            .await
            .ok()?,
    );

    let response = match client.nonce(Empty::default()).await {
        Ok(response) => response,
        Err(_) => {
            error!("Unable to fetch Nonce from endpoint");
            return None;
        }
    };

    // Fetch the session cookie for all future requests
    let session_cookie = match response.metadata().get(SESSION_COOKIE_KEY) {
        Some(session_cookie_raw) => match session_cookie_raw.to_str() {
            Ok(session_cookie) => session_cookie.to_string(),
            Err(_) => {
                error!("Unable to fetch session cookie from Nonce response");
                return None;
            }
        },
        None => {
            error!("Session cookie was not returned in Nonce response");
            return None;
        }
    };

    let nonce = response.into_inner().nonce;

    // Verify & authenticate with Valorem before connecting to RFQ endpoint.
    let mut client = AuthClient::with_interceptor(
        Channel::builder(valorem_uri)
            .tls_config(tls_config)
            .ok()?
            .http2_keep_alive_interval(Duration::new(75, 0))
            .keep_alive_timeout(Duration::new(10, 0))
            .timeout(Duration::from_secs(10))
            .connect_timeout(Duration::from_secs(10))
            .connect()
            .await
            .ok()?,
        SessionInterceptor {
            session_cookie: session_cookie.clone(),
        },
    );

    // Create a sign in with ethereum message
    let message = siwe::Message {
        domain: "localhost.com".parse().unwrap(),
        address: wallet.address().0,
        statement: Some(TOS_ACCEPTANCE.into()),
        uri: "http://localhost/".parse().unwrap(),
        version: Version::V1,
        chain_id: provider.get_chainid().await.unwrap().as_u64(),
        nonce,
        issued_at: TimeStamp::from(OffsetDateTime::now_utc()),
        expiration_time: None,
        not_before: None,
        request_id: None,
        resources: vec![],
    };

    // Generate a signature
    let message_string = message.to_string();
    let signature = wallet.sign_message(message_string.as_bytes()).await.unwrap();

    // Create the SignedMessage
    let signature_string = signature.to_string();
    let mut signed_message = serde_json::Map::new();
    signed_message.insert("signature".to_string(), serde_json::Value::from(signature_string));
    signed_message.insert("message".to_string(), serde_json::Value::from(message_string));
    let body = serde_json::Value::from(signed_message).to_string();

    let response = client.verify(VerifyText { body }).await;
    match response {
        Ok(_) => (),
        Err(error) => {
            error!("Unable to verify client. Reported error:\n{error:?}");
            return None;
        }
    }

    // Check that we have an authenticated session
    let response = client.authenticate(Empty::default()).await;
    match response {
        Ok(_) => (),
        Err(error) => {
            error!("Unable to check authentication with Valorem. Reported error:\n{error:?}");
            return None;
        }
    }

    info!("Maker has authenticated with Valorem");
    Some(session_cookie)
}

async fn approve_tokens<P: JsonRpcClient + 'static>(
    provider: &Arc<Provider<P>>,
    settings: &Settings,
    signer: &SignerMiddleware<Arc<Provider<P>>, LocalWallet>,
    settlement_contract: &bindings::valorem_clear::SettlementEngine<Provider<P>>,
    seaport_contract: &bindings::seaport::Seaport<Provider<P>>,
) {
    // Note: This approval logic is tied to what the example Taker is doing and may need to
    //       to be updated for your example
    // Take gas estimation out of the equation which can be dicey on the Arbitrum testnet.
    let gas = U256::from(500000u64);
    let gas_price = U256::from(200).mul(U256::exp10(8usize));

    // Approval for the Seaport contract
    let erc20_contract = bindings::erc20::Erc20::new(settings.magic_address, Arc::clone(provider));
    let mut approval_tx = erc20_contract.approve(seaport_contract.address(), U256::MAX).tx;
    approval_tx.set_gas(gas);
    approval_tx.set_gas_price(gas_price);
    signer.send_transaction(approval_tx, None).await.unwrap().await.unwrap();
    info!(
        "Approved Seaport ({:?}) to spend MAGIC ({:?})",
        seaport_contract.address(),
        settings.magic_address
    );

    // Pre-approve all Options for Seaport
    let mut approval_tx = settlement_contract
        .set_approval_for_all(seaport_contract.address(), true)
        .tx;
    approval_tx.set_gas(gas);
    approval_tx.set_gas_price(gas_price);
    signer.send_transaction(approval_tx, None).await.unwrap().await.unwrap();
    info!(
        "Pre-approved Seaport {:?} to move option tokens",
        seaport_contract.address()
    );

    // Token approval for the Valorem SettlementEngine
    let erc20_contract = bindings::erc20::Erc20::new(settings.usdc_address, Arc::clone(provider));
    let mut approve_tx = erc20_contract.approve(settings.settlement_contract, U256::MAX).tx;
    approve_tx.set_gas(gas);
    approve_tx.set_gas_price(gas_price);
    signer.send_transaction(approve_tx, None).await.unwrap().await.unwrap();
    info!(
        "Approved Settlement Engine ({:?}) to spend USDC ({:?})",
        settings.settlement_contract, settings.usdc_address
    );

    let erc20_contract = bindings::erc20::Erc20::new(settings.weth_address, Arc::clone(provider));
    let mut approve_tx = erc20_contract.approve(settings.settlement_contract, U256::MAX).tx;
    approve_tx.set_gas(gas);
    approve_tx.set_gas_price(gas_price);
    signer.send_transaction(approve_tx, None).await.unwrap().await.unwrap();
    info!(
        "Approved Settlement Engine ({:?}) to spend WETH ({:?})",
        settings.settlement_contract, settings.weth_address
    );

    let erc20_contract = bindings::erc20::Erc20::new(settings.wbtc_address, Arc::clone(provider));
    let mut approve_tx = erc20_contract.approve(settings.settlement_contract, U256::MAX).tx;
    approve_tx.set_gas(gas);
    approve_tx.set_gas_price(gas_price);
    signer.send_transaction(approve_tx, None).await.unwrap().await.unwrap();
    info!(
        "Approved Settlement Engine ({:?}) to spend WBTC ({:?})",
        settings.settlement_contract, settings.wbtc_address
    );

    let erc20_contract = bindings::erc20::Erc20::new(settings.gmx_address, Arc::clone(provider));
    let mut approve_tx = erc20_contract.approve(settings.settlement_contract, U256::MAX).tx;
    approve_tx.set_gas(gas);
    approve_tx.set_gas_price(gas_price);
    signer.send_transaction(approve_tx, None).await.unwrap().await.unwrap();
    info!(
        "Approved Settlement Engine ({:?}) to spend GMX ({:?})",
        settings.settlement_contract, settings.gmx_address
    );

    let erc20_contract = bindings::erc20::Erc20::new(settings.magic_address, Arc::clone(provider));
    let mut approve_tx = erc20_contract.approve(settings.settlement_contract, U256::MAX).tx;
    approve_tx.set_gas(gas);
    approve_tx.set_gas_price(gas_price);
    signer.send_transaction(approve_tx, None).await.unwrap().await.unwrap();
    info!(
        "Approved Settlement Engine ({:?}) to spend MAGIC ({:?})",
        settings.settlement_contract, settings.magic_address
    );
}

pub fn time_now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()
}
