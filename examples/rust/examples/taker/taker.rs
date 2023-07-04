use crate::settings::Settings;
use ethers::abi::{AbiEncode, RawLog};
use ethers::prelude::{
    Address, Bytes, EthLogDecode, Http, JsonRpcClient, LocalWallet, Middleware, Provider,
    Signature, Signer, SignerMiddleware, Ws, U256,
};
use http::Uri;
use siwe::{TimeStamp, Version};
use std::env;
use std::ops::Mul;
use std::process::exit;
use std::sync::Arc;
use time::OffsetDateTime;
use tokio::sync::mpsc;
use tonic::transport::{Channel, ClientTlsConfig};
use valorem_trade_interfaces::bindings;
use valorem_trade_interfaces::grpc_codegen::auth_client::AuthClient;
use valorem_trade_interfaces::grpc_codegen::rfq_client::RfqClient;
use valorem_trade_interfaces::grpc_codegen::{Action, ItemType, QuoteRequest, H256};
use valorem_trade_interfaces::grpc_codegen::{Empty, VerifyText};
use valorem_trade_interfaces::utils::session_interceptor::SessionInterceptor;

mod settings;

const SESSION_COOKIE_KEY: &str = "set-cookie";
const SECONDS_IN_A_DAY: u64 = 86400u64;
const SECONDS_IN_THIRTY_MINUTES: u64 = 1800u64;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.len() != 1 {
        eprintln!("Unexpected command line arguments. Received {:?}", args);
        eprintln!("Usage: taker <settings_file>");
        exit(1);
    }

    let settings = Settings::load(&args[0]);

    if settings.node_endpoint.starts_with("http") {
        let provider = Provider::<Http>::try_from(settings.node_endpoint.clone())?;
        run(Arc::new(provider), settings).await;
    } else if settings.node_endpoint.starts_with("ws") {
        // Websockets (ws & wss)
        let provider = Provider::<Ws>::new(Ws::connect(settings.node_endpoint.clone()).await?);
        run(Arc::new(provider), settings).await;
    } else {
        // IPC
        let provider = Provider::connect_ipc(settings.node_endpoint.clone()).await?;
        run(Arc::new(provider), settings).await;
    }

    Ok(())
}

/// Main execution function. The Taker will execute the following use case.
/// 1. Connect and authorise itself with Valorem
/// 2. Create an Option Type
/// 3. Request a buy quote from the Maker
/// 4. If the Maker offers a quote:
/// 5. Accept and fulfill the Order from the Maker
/// 6. Request a sell quote from the Maker
/// 7. Accept and fulfill the Order from the Maker
/// 8. Exit
///
/// If there are any unexpected errors the function will print what information it has and then
/// exit.
async fn run<P: JsonRpcClient + 'static>(provider: Arc<Provider<P>>, settings: Settings) {
    let session_cookie = setup_valorem_connection(
        settings.valorem_endpoint.clone(),
        settings.wallet.clone(),
        settings.tls_config.clone(),
        &provider,
    )
    .await;

    // Now there is a valid authenticated session, connect to the RFQ stream
    let mut client = RfqClient::with_interceptor(
        Channel::builder(settings.valorem_endpoint.clone())
            .tls_config(settings.tls_config.clone())
            .unwrap()
            .http2_keep_alive_interval(std::time::Duration::from_secs(75))
            .connect()
            .await
            .unwrap(),
        SessionInterceptor { session_cookie },
    );

    // Valorem Settlement Engine
    let settlement_engine = bindings::valorem_clear::SettlementEngine::new(
        settings.settlement_contract,
        Arc::clone(&provider),
    );
    let signer =
        SignerMiddleware::new_with_provider_chain(Arc::clone(&provider), settings.wallet.clone())
            .await
            .unwrap();

    // Seaport 1.1
    let seaport_contract_address = "0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC"
        .parse::<Address>()
        .unwrap();
    let seaport = bindings::seaport::Seaport::new(seaport_contract_address, Arc::clone(&provider));

    // Approve the tokens the example will be using on Arbitrum Testnet
    if settings.approve_tokens {
        approve_test_tokens(&provider, &signer, &settlement_engine, &seaport).await;
    }

    // Setup the stream between us and Valorem which the gRPC connection will use.
    // Note: We don't setup any auto-reconnect functionality since we are only executing for a
    //       small amount of time. However this should be considered for an operational taker.
    let (tx_rfq, rx_rfq) = mpsc::channel::<QuoteRequest>(64);
    let mut rfq_stream = client
        .taker(tokio_stream::wrappers::ReceiverStream::new(rx_rfq))
        .await
        .unwrap()
        .into_inner();

    // Create the option type we will use to request an RFQ on
    let option_id = setup_option(&settlement_engine, &signer).await;

    // Take gas estimation out of the equation which can be dicey on the Arbitrum testnet.
    let gas = U256::from(500000u64);
    let gas_price = U256::from(2000).mul(U256::exp10(8usize));

    // Now we have received the gRPC server's request stream - start the test case.
    // Buy Order
    let rfq = QuoteRequest {
        ulid: None,
        taker_address: Some(settings.wallet.address().into()),
        item_type: ItemType::Erc1155 as i32,
        token_address: None,
        identifier_or_criteria: Some(option_id.into()),
        amount: Some(U256::from(5u8).into()),
        action: Action::Buy as i32,
        chain_id: None,
        seaport_address: None,
    };

    let mut sell_rfq = false;

    println!();
    println!("Sending Buy RFQ to Maker for Option Type {:?}", option_id);
    tx_rfq.send(rfq.clone()).await.unwrap();

    loop {
        // We expect the message to be returned on the stream back
        if let Ok(Some(offer)) = rfq_stream.message().await {
            if offer.order.is_none() {
                println!("Maker did not wish to make a quote on the Order.");
                println!();
                println!("Sending Buy RFQ to Maker for Option Type {:?}", option_id);
                tx_rfq.send(rfq.clone()).await.unwrap();
                continue;
            }

            let offered_order = offer.order.unwrap();
            let offer_parameters = offered_order.parameters.clone().unwrap();
            println!(
                "Received offer from Maker. {:?} ({:?}) for {:?} options",
                U256::from(
                    offer_parameters.consideration[0]
                        .start_amount
                        .clone()
                        .unwrap()
                ),
                Address::from(offer_parameters.consideration[0].token.clone().unwrap()),
                U256::from(offer_parameters.offer[0].start_amount.clone().unwrap()),
            );

            let order = transform_to_seaport_order(&offered_order, offer_parameters);
            let option_id = order.parameters.offer[0].identifier_or_criteria;

            let mut order_tx = seaport.fulfill_order(order, [0u8; 32]).tx;
            order_tx.set_gas(gas);
            order_tx.set_gas_price(gas_price);
            let pending_tx = match signer.send_transaction(order_tx, None).await {
                Ok(pending_tx) => pending_tx,
                Err(error) => {
                    eprintln!("Error: Unable to send fulfill order transaction to Seaport for fulfillment.");
                    eprintln!("Reported error: {:?}", error);
                    exit(1);
                }
            };

            // Wait until the tx has been handled by the sequencer.
            pending_tx.await.unwrap();

            if !sell_rfq {
                let owned_tokens = settlement_engine
                    .balance_of(signer.address(), option_id)
                    .call()
                    .await
                    .unwrap();
                assert_eq!(owned_tokens, U256::from(5u8));

                // Now sell all the options right back
                // Sell Order
                let rfq = QuoteRequest {
                    ulid: None,
                    taker_address: Some(settings.wallet.address().into()),
                    item_type: ItemType::Erc1155 as i32,
                    token_address: Some(settlement_engine.address().into()),
                    identifier_or_criteria: Some(option_id.into()),
                    amount: Some(U256::from(5u8).into()),
                    action: Action::Sell as i32,
                    chain_id: None,
                    seaport_address: None,
                };
                println!("Sending Sell RFQ to Maker for Option Id {:?}", option_id);
                sell_rfq = true;
                tx_rfq.send(rfq).await.unwrap();
            } else {
                let owned_tokens = settlement_engine
                    .balance_of(signer.address(), option_id)
                    .call()
                    .await
                    .unwrap();
                assert_eq!(owned_tokens, U256::zero());
                println!("Sold all options back to Maker");
                println!("Test case successfully finished.");
                exit(1);
            }
        } else {
            panic!("Error while reading from the servers request stream! This should be impossible for this example case.");
        }
    }
}

// Transform the gRPC details into an ethers-rs Order structure so we can call
// the on-chain seaport contract.
// Note: Even though we have all the disassembled parameters the order has been
//       pre-signed by the Maker, so if we change anything the signature will not
//       match.
fn transform_to_seaport_order(
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

// Create and setup the connection to Valorem
async fn setup_valorem_connection<P: JsonRpcClient + 'static>(
    valorem_uri: Uri,
    wallet: LocalWallet,
    tls_config: ClientTlsConfig,
    provider: &Arc<Provider<P>>,
) -> String {
    // Connect and authenticate with Valorem
    let mut client: AuthClient<Channel> = AuthClient::new(
        Channel::builder(valorem_uri.clone())
            .tls_config(tls_config.clone())
            .unwrap()
            .connect()
            .await
            .unwrap(),
    );
    let response = client
        .nonce(Empty::default())
        .await
        .expect("Unable to fetch Nonce");

    // Fetch the session cookie for all future requests
    let session_cookie = response
        .metadata()
        .get(SESSION_COOKIE_KEY)
        .expect("Session cookie was not returned in Nonce response")
        .to_str()
        .expect("Unable to fetch session cookie from Nonce response")
        .to_string();

    let nonce = response.into_inner().nonce;

    // Verify & authenticate with Valorem before connecting to RFQ endpoint.
    let mut client = AuthClient::with_interceptor(
        Channel::builder(valorem_uri)
            .tls_config(tls_config)
            .unwrap()
            .connect()
            .await
            .unwrap(),
        SessionInterceptor {
            session_cookie: session_cookie.clone(),
        },
    );

    // Create a sign in with ethereum message
    let message = siwe::Message {
        domain: "localhost.com".parse().unwrap(),
        address: wallet.address().0,
        statement: None,
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
    let signature = wallet
        .sign_message(message_string.as_bytes())
        .await
        .unwrap();

    // Create the SignedMessage
    let signature_string = signature.to_string();
    let mut signed_message = serde_json::Map::new();
    signed_message.insert(
        "signature".to_string(),
        serde_json::Value::from(signature_string),
    );
    signed_message.insert(
        "message".to_string(),
        serde_json::Value::from(message_string),
    );
    let body = serde_json::Value::from(signed_message).to_string();

    let response = client.verify(VerifyText { body }).await;
    match response {
        Ok(_) => (),
        Err(error) => {
            eprintln!("Error: Unable to verify client. Reported error:\n{error:?}");
            exit(1);
        }
    }

    // Check that we have an authenticated session
    let response = client.authenticate(Empty::default()).await;
    match response {
        Ok(_) => (),
        Err(error) => {
            eprintln!(
                "Error: Unable to check authentication with Valorem. Reported error:\n{error:?}"
            );
            exit(1);
        }
    }

    println!("Client has authenticated with Valorem");
    session_cookie
}

// Create the option that we'll send RFQs on.
// Note: Ideally we also return the exercise and expiry timestamps in order to ensure we can
//       exercise the option (if profitable) before it expires. However as this is an example
//       and the minimum duration of an option is 1 day from creation to exercise and than 1 day
//       from exercise to expiry we leave this part out.
async fn setup_option<P: JsonRpcClient + 'static>(
    contract: &bindings::valorem_clear::SettlementEngine<Provider<P>>,
    signer: &SignerMiddleware<Arc<Provider<P>>, LocalWallet>,
) -> U256 {
    // MAGIC on Arbitrum testnet
    let underlying_asset = "0xb795f8278458443f6C43806C020a84EB5109403c"
        .parse::<Address>()
        .unwrap();
    let underlying_amount = U256::from_dec_str("5000000000000000000").unwrap().as_u128();

    // GMX on Arbitrum testnet
    let exercise_asset = "0x8AE0EeedD35DbEFe460Df12A20823eFDe9e03458"
        .parse::<Address>()
        .unwrap();
    let exercise_amount = U256::from_dec_str("10000000").unwrap().as_u128();

    // Create the option
    let block_number = signer.provider().get_block_number().await.unwrap();
    let block_timestamp = signer
        .provider()
        .get_block(block_number)
        .await
        .unwrap()
        .unwrap()
        .timestamp
        .as_u64();
    let exercise_timestamp = block_timestamp + SECONDS_IN_A_DAY + SECONDS_IN_THIRTY_MINUTES;
    let expiry_timestamp = exercise_timestamp + SECONDS_IN_A_DAY;

    let mut tx = contract
        .new_option_type(
            underlying_asset,
            underlying_amount,
            exercise_asset,
            exercise_amount,
            exercise_timestamp,
            expiry_timestamp,
        )
        .tx;

    // Take gas estimation out of the equation which can be dicey on the Arbitrum testnet.
    tx.set_gas(U256::from(500000u64));
    tx.set_gas_price(U256::from(2000).mul(U256::exp10(8usize)));

    let pending_tx = match signer.send_transaction(tx, None).await {
        Ok(pending_tx) => pending_tx,
        Err(err) => {
            eprintln!("Error: Unable to create a new option type. Reported error: {err:?}");
            exit(1);
        }
    };

    let transaction_receipt = match pending_tx.await {
        Ok(Some(transaction_receipt)) => transaction_receipt,
        Ok(None) => {
            eprintln!("Error: No transaction receipt returned from the pending tx that is creating the option");
            exit(1);
        }
        Err(err) => {
            eprintln!("Error: Provider error while awaiting the pending tx that is creating the option. Reported error: {err:?}");
            exit(1);
        }
    };

    for log_entry in transaction_receipt.logs {
        let topics = log_entry.topics.clone();
        let data = log_entry.data.to_vec();
        let event =
            bindings::valorem_clear::SettlementEngineEvents::decode_log(&RawLog { topics, data })
                .unwrap();

        if let bindings::valorem_clear::SettlementEngineEvents::NewOptionTypeFilter(event) = event {
            println!(
                "Option Id successfully created. Option Id {:?}",
                event.option_id
            );
            return event.option_id;
        }
    }

    eprintln!("Error: Unable to find NewOptionType event within the logs of the tx that created the option!");
    exit(1);
}

// Approve the test tokens to used within the Arbitrum testnet
async fn approve_test_tokens<P: JsonRpcClient + 'static>(
    provider: &Arc<Provider<P>>,
    signer: &SignerMiddleware<Arc<Provider<P>>, LocalWallet>,
    settlement_contract: &bindings::valorem_clear::SettlementEngine<Provider<P>>,
    seaport_contract: &bindings::seaport::Seaport<Provider<P>>,
) {
    // Take gas estimation out of the equation which can be dicey on the testnet.
    let gas = U256::from(500000u64);
    let gas_price = U256::from(2000).mul(U256::exp10(8usize));

    // Approval for the Seaport contract
    let magic = "0xb795f8278458443f6C43806C020a84EB5109403c"
        .parse::<Address>()
        .unwrap();
    let erc20_contract = bindings::erc20::Erc20::new(magic, Arc::clone(provider));
    let mut approval_tx = erc20_contract
        .approve(seaport_contract.address(), U256::MAX)
        .tx;
    approval_tx.set_gas(gas);
    approval_tx.set_gas_price(gas_price);
    signer
        .send_transaction(approval_tx, None)
        .await
        .unwrap()
        .await
        .unwrap();
    println!(
        "Approved Seaport ({:?}) to spend MAGIC ({:?})",
        seaport_contract.address(),
        magic
    );

    // Pre-approve all Options for Seaport (which will be the conduit in this case)
    let mut approval_tx = settlement_contract
        .set_approval_for_all(seaport_contract.address(), true)
        .tx;
    approval_tx.set_gas(gas);
    approval_tx.set_gas_price(gas_price);
    signer
        .send_transaction(approval_tx, None)
        .await
        .unwrap()
        .await
        .unwrap();
    println!(
        "Pre-approved Seaport {:?} to move option tokens",
        seaport_contract.address()
    );

    // Token approval for the Valorem SettlementEngine
    let usdc = "0x8FB1E3fC51F3b789dED7557E680551d93Ea9d892"
        .parse::<Address>()
        .unwrap();
    let erc20_contract = bindings::erc20::Erc20::new(usdc, Arc::clone(provider));
    let mut approve_tx = erc20_contract
        .approve(settlement_contract.address(), U256::MAX)
        .tx;
    approve_tx.set_gas(gas);
    approve_tx.set_gas_price(gas_price);
    signer
        .send_transaction(approve_tx, None)
        .await
        .unwrap()
        .await
        .unwrap();
    println!(
        "Approved Settlement Engine ({:?}) to spend USDC ({:?})",
        settlement_contract.address(),
        usdc
    );

    let weth = "0xe39Ab88f8A4777030A534146A9Ca3B52bd5D43A3"
        .parse::<Address>()
        .unwrap();
    let erc20_contract = bindings::erc20::Erc20::new(weth, Arc::clone(provider));
    let mut approve_tx = erc20_contract
        .approve(settlement_contract.address(), U256::MAX)
        .tx;
    approve_tx.set_gas(gas);
    approve_tx.set_gas_price(gas_price);
    signer
        .send_transaction(approve_tx, None)
        .await
        .unwrap()
        .await
        .unwrap();
    println!(
        "Approved Settlement Engine ({:?}) to spend WETH ({:?})",
        settlement_contract.address(),
        weth
    );

    let wbtc = "0xf8Fe24D6Ea205dd5057aD2e5FE5e313AeFd52f2e"
        .parse::<Address>()
        .unwrap();
    let erc20_contract = bindings::erc20::Erc20::new(wbtc, Arc::clone(provider));
    let mut approve_tx = erc20_contract
        .approve(settlement_contract.address(), U256::MAX)
        .tx;
    approve_tx.set_gas(gas);
    approve_tx.set_gas_price(gas_price);
    signer
        .send_transaction(approve_tx, None)
        .await
        .unwrap()
        .await
        .unwrap();
    println!(
        "Approved Settlement Engine ({:?}) to spend WBTC ({:?})",
        settlement_contract.address(),
        wbtc
    );

    let gmx = "0x5337deF26Da2506e08e37682b0d6E50b26a704BB"
        .parse::<Address>()
        .unwrap();
    let erc20_contract = bindings::erc20::Erc20::new(gmx, Arc::clone(provider));
    let mut approve_tx = erc20_contract
        .approve(settlement_contract.address(), U256::MAX)
        .tx;
    approve_tx.set_gas(gas);
    approve_tx.set_gas_price(gas_price);
    signer
        .send_transaction(approve_tx, None)
        .await
        .unwrap()
        .await
        .unwrap();
    println!(
        "Approved Settlement Engine ({:?}) to spend GMX ({:?})",
        settlement_contract.address(),
        gmx
    );

    let magic = "0xb795f8278458443f6C43806C020a84EB5109403c"
        .parse::<Address>()
        .unwrap();
    let erc20_contract = bindings::erc20::Erc20::new(magic, Arc::clone(provider));
    let mut approve_tx = erc20_contract
        .approve(settlement_contract.address(), U256::MAX)
        .tx;
    approve_tx.set_gas(gas);
    approve_tx.set_gas_price(gas_price);
    signer
        .send_transaction(approve_tx, None)
        .await
        .unwrap()
        .await
        .unwrap();
    println!(
        "Approved Settlement Engine ({:?}) to spend MAGIC ({:?})",
        settlement_contract.address(),
        magic
    );
}
