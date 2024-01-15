use crate::settings::Settings;
use ethers::prelude::{JsonRpcClient, LocalWallet, Middleware, Provider, SignerMiddleware, U256};
use log::info;
use std::{ops::Mul, sync::Arc};
use valorem_trade_interfaces::bindings;

pub async fn approve_tokens<P: JsonRpcClient + 'static>(
    provider: &Arc<Provider<P>>,
    settings: &Settings,
    signer: &SignerMiddleware<Arc<Provider<P>>, LocalWallet>,
    settlement_contract: &bindings::valorem_clear::SettlementEngine<Provider<P>>,
    seaport_contract: &bindings::seaport::Seaport<Provider<P>>,
) {
    // Note: This approval logic is tied to what the example Taker is doing and may need to
    //       to be updated for your example
    // Take gas estimation out of the equation which can be dicey on the Arbitrum testnet.
    let gas = U256::from(900000u64);
    let gas_price = U256::from(300).mul(U256::exp10(8usize));

    // Approval for the Seaport contract
    let erc20_contract = bindings::erc20::Erc20::new(settings.usdc_address, Arc::clone(provider));
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
    info!(
        "Approved Seaport ({:?}) to spend USDC ({:?})",
        seaport_contract.address(),
        settings.usdc_address
    );

    // Pre-approve all Options for Seaport
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
    info!(
        "Pre-approved Seaport {:?} to move option tokens",
        seaport_contract.address()
    );

    // Token approval for the Valorem SettlementEngine
    let erc20_contract = bindings::erc20::Erc20::new(settings.usdc_address, Arc::clone(provider));
    let mut approve_tx = erc20_contract
        .approve(settings.settlement_contract, U256::MAX)
        .tx;
    approve_tx.set_gas(gas);
    approve_tx.set_gas_price(gas_price);
    signer
        .send_transaction(approve_tx, None)
        .await
        .unwrap()
        .await
        .unwrap();
    info!(
        "Approved Settlement Engine ({:?}) to spend USDC ({:?})",
        settings.settlement_contract, settings.usdc_address
    );

    let erc20_contract = bindings::erc20::Erc20::new(settings.weth_address, Arc::clone(provider));
    let mut approve_tx = erc20_contract
        .approve(settings.settlement_contract, U256::MAX)
        .tx;
    approve_tx.set_gas(gas);
    approve_tx.set_gas_price(gas_price);
    signer
        .send_transaction(approve_tx, None)
        .await
        .unwrap()
        .await
        .unwrap();
    info!(
        "Approved Settlement Engine ({:?}) to spend WETH ({:?})",
        settings.settlement_contract, settings.weth_address
    );

    let erc20_contract = bindings::erc20::Erc20::new(settings.wbtc_address, Arc::clone(provider));
    let mut approve_tx = erc20_contract
        .approve(settings.settlement_contract, U256::MAX)
        .tx;
    approve_tx.set_gas(gas);
    approve_tx.set_gas_price(gas_price);
    signer
        .send_transaction(approve_tx, None)
        .await
        .unwrap()
        .await
        .unwrap();
    info!(
        "Approved Settlement Engine ({:?}) to spend WBTC ({:?})",
        settings.settlement_contract, settings.wbtc_address
    );

    let erc20_contract = bindings::erc20::Erc20::new(settings.gmx_address, Arc::clone(provider));
    let mut approve_tx = erc20_contract
        .approve(settings.settlement_contract, U256::MAX)
        .tx;
    approve_tx.set_gas(gas);
    approve_tx.set_gas_price(gas_price);
    signer
        .send_transaction(approve_tx, None)
        .await
        .unwrap()
        .await
        .unwrap();
    info!(
        "Approved Settlement Engine ({:?}) to spend GMX ({:?})",
        settings.settlement_contract, settings.gmx_address
    );

    let erc20_contract = bindings::erc20::Erc20::new(settings.magic_address, Arc::clone(provider));
    let mut approve_tx = erc20_contract
        .approve(settings.settlement_contract, U256::MAX)
        .tx;
    approve_tx.set_gas(gas);
    approve_tx.set_gas_price(gas_price);
    signer
        .send_transaction(approve_tx, None)
        .await
        .unwrap()
        .await
        .unwrap();
    info!(
        "Approved Settlement Engine ({:?}) to spend MAGIC ({:?})",
        settings.settlement_contract, settings.magic_address
    );
}
