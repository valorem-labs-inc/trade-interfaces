use config::{Config, File};
use ethers::prelude::{Address, LocalWallet, Wallet};
use http::Uri;
use rpassword::read_password;
use serde::Deserialize;
use std::fs::read_to_string;
use std::io::{stdout, Write};
use std::str::FromStr;
use tonic::transport::{Certificate, ClientTlsConfig};

#[derive(Deserialize, Clone, Debug)]
struct InnerSettings {
    node_endpoint: String,
    valorem_endpoint: String,
    settlement_contract: String,
    keystore: Option<String>,
    private_key: Option<String>,
    ca_root: Option<String>,
    domain_name: Option<String>,
    approve_tokens: bool,
    magic_address: String,
    usdc_address: String,
    weth_address: String,
    wbtc_address: String,
    gmx_address: String,
}

#[derive(Clone, Debug)]
pub struct Settings {
    pub node_endpoint: String,
    pub valorem_endpoint: Uri,
    pub settlement_contract: Address,
    pub wallet: LocalWallet,
    pub tls_config: ClientTlsConfig,
    pub approve_tokens: bool,
    pub magic_address: Address,
    pub usdc_address: Address,
    pub weth_address: Address,
    pub wbtc_address: Address,
    pub gmx_address: Address,
}

impl Settings {
    pub fn load(file: &str) -> Self {
        let settings = Config::builder().add_source(File::with_name(file)).build().unwrap();
        let inner: InnerSettings = settings.try_deserialize().unwrap();

        let wallet = if let Some(keystore) = inner.keystore {
            decrypt_keystore(&keystore)
        } else {
            fetch_private_key(inner.private_key)
        };

        // TLS Configuration, use default settings unless provided with an alternate
        let pem = if let Some(ca_root) = inner.ca_root {
            read_to_string(ca_root).unwrap()
        } else {
            read_to_string("/etc/ssl/cert.pem").unwrap()
        };

        let domain_name = inner.domain_name.unwrap_or(String::from("trade.valorem.xyz"));

        let ca = Certificate::from_pem(pem);
        let tls_config = ClientTlsConfig::new().ca_certificate(ca).domain_name(domain_name);

        Settings {
            node_endpoint: inner.node_endpoint,
            valorem_endpoint: inner.valorem_endpoint.parse::<Uri>().unwrap(),
            settlement_contract: inner.settlement_contract.parse::<Address>().unwrap(),
            magic_address: inner.magic_address.parse::<Address>().unwrap(),
            usdc_address: inner.usdc_address.parse::<Address>().unwrap(),
            weth_address: inner.weth_address.parse::<Address>().unwrap(),
            wbtc_address: inner.wbtc_address.parse::<Address>().unwrap(),
            gmx_address: inner.gmx_address.parse::<Address>().unwrap(),
            wallet,
            tls_config,
            approve_tokens: inner.approve_tokens,
        }
    }
}

fn decrypt_keystore(path: &str) -> LocalWallet {
    print!("Enter password for keystore {path} (will not be shown): ");
    stdout().flush().unwrap();
    let password = read_password().unwrap();

    match Wallet::decrypt_keystore(path, password) {
        Ok(wallet) => wallet,
        Err(err) => panic!("Failed to decrypt keystore ({path}) with the error: {err:?}"),
    }
}

fn fetch_private_key(inner_private_key: Option<String>) -> LocalWallet {
    let private_key = inner_private_key.unwrap_or_else(|| {
        print!("Enter private key (will not be shown): ");
        stdout().flush().unwrap();
        read_password().unwrap().trim().to_string()
    });

    match LocalWallet::from_str(private_key.as_str()) {
        Ok(wallet) => wallet,
        Err(err) => panic!("Unable to create wallet from private key. Error returned {err:?}"),
    }
}
