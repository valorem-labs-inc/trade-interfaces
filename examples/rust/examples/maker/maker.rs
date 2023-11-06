use crate::rfq_request::{handle_rfq_request, validate_rfq};
use crate::settings::Settings;
use crate::soft_quote_request::{handle_soft_quote_request, validate_soft_quote};
use crate::token_approvals::approve_tokens;
use ethers::prelude::{
    Address, Http, Ipc, JsonRpcClient, LocalWallet, Middleware, Provider, Signer, SignerMiddleware,
    Ws, U256,
};
use http::Uri;
use log::{error, info, warn};
use siwe::{TimeStamp, Version};
use std::time::{SystemTime, UNIX_EPOCH};
use std::{env, process::exit, sync::Arc, time::Duration};
use time::OffsetDateTime;
use tokio::select;
use tokio::{sync::mpsc, time::sleep};
use tonic::transport::{Channel, ClientTlsConfig};
use valorem_trade_interfaces::utils::session_interceptor::SessionInterceptor;
use valorem_trade_interfaces::{
    bindings, grpc_codegen,
    grpc_codegen::{
        auth_client::AuthClient, rfq_client::RfqClient, soft_quote_client::SoftQuoteClient, Empty,
        QuoteRequest, QuoteResponse, SoftQuoteResponse, VerifyText,
    },
};

mod rfq_request;
mod seaport_helper;
mod settings;
mod soft_quote_request;
mod token_approvals;

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
        error!("Unexpected command line arguments. Received {:?}", args);
        error!("Usage: maker <settings_file>");
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
async fn run<P: JsonRpcClient + 'static>(
    provider: Arc<Provider<P>>,
    settings: Settings,
) -> Option<()> {
    let session_cookie = setup(
        settings.valorem_endpoint.clone(),
        settings.wallet.clone(),
        settings.tls_config.clone(),
        &provider,
    )
    .await?;

    // Now there is a valid authenticated session, connect to the RFQ stream
    let channel_builder = connect_to_valorem(
        settings.valorem_endpoint.clone(),
        settings.tls_config.clone(),
    )
    .await?;

    let mut rfq_client = RfqClient::with_interceptor(
        channel_builder.clone(),
        SessionInterceptor {
            session_cookie: session_cookie.clone(),
        },
    );

    let mut soft_quote_client =
        SoftQuoteClient::with_interceptor(channel_builder, SessionInterceptor { session_cookie });

    // Setup a signer so we can send transactions
    let settlement_engine = bindings::valorem_clear::SettlementEngine::new(
        settings.settlement_contract,
        Arc::clone(&provider),
    );

    // We do an unchecked unwrap since if an error is returned it was due to not being able to get the chain_id
    // from the provider.
    let signer = match SignerMiddleware::new_with_provider_chain(
        Arc::clone(&provider),
        settings.wallet.clone(),
    )
    .await
    {
        Ok(signer) => signer,
        Err(error) => {
            warn!("Error while attempting to create signer. Internally Ethers-rs will query the chain_id. Reported error {error:?}");
            return None;
        }
    };

    // Seaport 1.5 contract address
    // Note: We allow the unchecked unwrap here, since this address will always parse correctly.
    let seaport_contract_address = "0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC"
        .parse::<Address>()
        .unwrap();

    let seaport = bindings::seaport::Seaport::new(seaport_contract_address, Arc::clone(&provider));

    // Approve the tokens the example will be using
    if settings.approve_tokens {
        approve_tokens(&provider, &settings, &signer, &settlement_engine, &seaport).await;
    }

    // The gRPC stream might end for a couple of reasons, for example:
    // * There are no clients connected after a RFQ
    // * Infrastructure middle men (like Cloudflare) has killed the connection.
    loop {
        // Setup the stream between us and Valorem which the Soft Quoting gRPC connection will use.
        let (tx_soft_quote_response, rx_soft_quote_response) =
            mpsc::channel::<SoftQuoteResponse>(64);
        let soft_stream = match soft_quote_client
            .maker(tokio_stream::wrappers::ReceiverStream::new(
                rx_soft_quote_response,
            ))
            .await
        {
            Ok(soft_quote_stream) => soft_quote_stream,
            Err(error) => {
                warn!("Unable to create the Maker Soft Quote stream. Reported error {error:?}");
                return None;
            }
        };

        // Setup the stream between us and Valorem which the RFQ gRPC connection will use.
        let (tx_quote_response, rx_quote_response) = mpsc::channel::<QuoteResponse>(64);

        let maker_stream = match rfq_client
            .maker(tokio_stream::wrappers::ReceiverStream::new(
                rx_quote_response,
            ))
            .await
        {
            Ok(maker_stream) => maker_stream,
            Err(error) => {
                warn!("Unable to create the Maker RFQ stream. Reported error {error:?}");
                return None;
            }
        };

        let mut rfq_stream = maker_stream.into_inner();
        let mut quote_stream = soft_stream.into_inner();

        info!("Ready for RFQs and Soft Quotes from Takers");

        loop {
            select! {
                quote = rfq_stream.message() => {
                    if let Ok(Some(quote)) = quote {
                        // Check the chain-id is valid
                        if quote.chain_id.is_none() {
                            warn!(
                                "Invalid RFQ request was received. No chain-id was given, ignoring the request"
                            );
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
                            handle_rfq_request(
                                quote,
                                &settlement_engine,
                                &signer,
                                &seaport,
                                settings.usdc_address,
                            )
                            .await?
                        };

                        if tx_quote_response.send(quote_offer).await.is_err() {
                            warn!("Received error while attempting to send offer back on Maker RFQ channel. Reconnecting.");
                            return None;
                        }
                    } else {
                        warn!("Error while handling the RFQ stream");
                        return None;
                    }
                },
                soft_quote = quote_stream.message() => {
                    if let Ok(Some(quote)) = soft_quote {
                        // Check the chain-id is valid
                        if quote.chain_id.is_none() {
                            warn!(
                                "Invalid Soft Quote request was received. No chain-id was given, ignoring the request"
                            );
                            continue;
                        }

                        let chain_id: U256 = quote.chain_id.clone().unwrap().into();
                        if chain_id != U256::from(421613_u64) {
                            warn!("Soft Quote request was not on the testnet chain. Ignoring the request");
                            continue;
                        }

                        let quote_offer = if validate_soft_quote(quote.clone()).is_none() {
                            // Malformed RFQ return a no-quote
                            create_soft_quote_no_offer(&quote, &signer)
                        } else {
                            handle_soft_quote_request(
                                quote,
                                &settlement_engine,
                                &signer,
                                &seaport,
                                settings.usdc_address,
                            )
                            .await?
                        };

                        if tx_soft_quote_response.send(quote_offer).await.is_err() {
                            warn!("Received error while attempting to send offer back on Maker Soft Quote channel. Reconnecting.");
                            return None;
                        }
                    } else {
                        warn!("Error while handling the Soft Quote stream");
                        return None;
                    }
                }
            }
        }
    }
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

// Create the "No offer" response data
fn create_soft_quote_no_offer<P: JsonRpcClient + 'static>(
    request_for_quote: &QuoteRequest,
    signer: &SignerMiddleware<Arc<Provider<P>>, LocalWallet>,
) -> SoftQuoteResponse {
    SoftQuoteResponse {
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
    let channel_builder = connect_to_valorem(valorem_uri.clone(), tls_config.clone()).await?;
    let mut client: AuthClient<Channel> = AuthClient::new(channel_builder);

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
    let channel_builder = connect_to_valorem(valorem_uri, tls_config).await?;
    let mut client = AuthClient::with_interceptor(
        channel_builder,
        SessionInterceptor {
            session_cookie: session_cookie.clone(),
        },
    );

    let chain_id = fetch_chain_id(&provider).await?.as_u64();

    // Create a sign in with ethereum message
    let message = siwe::Message {
        domain: "localhost.com".parse().unwrap(),
        address: wallet.address().0,
        statement: Some(TOS_ACCEPTANCE.into()),
        uri: "http://localhost/".parse().unwrap(),
        version: Version::V1,
        chain_id,
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

fn time_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

// Helper function to fetch the chain id.
async fn fetch_chain_id<P: JsonRpcClient + 'static>(provider: &Provider<P>) -> Option<U256> {
    match provider.get_chainid().await {
        Ok(chain_id) => Some(chain_id),
        Err(error) => {
            warn!("ChainId Fetch: Error while attempting to get the chain_id. Reported error {error:?}");
            return None;
        }
    }
}

// Helper function to connect to Valorem.
async fn connect_to_valorem(
    valorem_uri: Uri,
    tls_config: ClientTlsConfig,
) -> Option<tonic::transport::Channel> {
    let builder = match Channel::builder(valorem_uri).tls_config(tls_config) {
        Ok(builder) => builder,
        Err(error) => {
            panic!("Unable to add in TLS configuration to the channel builder. Error returned {error:?}")
        }
    };

    match builder
        .http2_keep_alive_interval(Duration::new(75, 0))
        .keep_alive_timeout(Duration::new(10, 0))
        .timeout(Duration::from_secs(10))
        .connect_timeout(Duration::from_secs(10))
        .connect()
        .await
    {
        Ok(builder) => Some(builder),
        Err(error) => {
            warn!("Unable to connect to Valorem endpoint. Reported error {error:?}");
            return None;
        }
    }
}
