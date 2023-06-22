use ethers::contract::abigen;

abigen!(
    SettlementEngine,
    "../abi/IValoremOptionsClearinghouse.json",
    event_derives(serde::Deserialize, serde::Serialize)
);