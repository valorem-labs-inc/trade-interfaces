use ethers::prelude::{
    Address, JsonRpcClient, LocalWallet, Middleware, Provider, SignerMiddleware, U256,
};
use std::ops::Mul;
use std::sync::Arc;
use valorem_trade_interfaces::bindings;

// Approve the test tokens to used within the Arbitrum testnet
pub async fn approve_test_tokens<P: JsonRpcClient + 'static>(
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
