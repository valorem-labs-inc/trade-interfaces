use ethers::contract::abigen;

abigen!(
    Seaport,
    "../abi/ISeaport.json",
    derives(serde::Deserialize, serde::Serialize)
);
