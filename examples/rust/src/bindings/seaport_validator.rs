use ethers::contract::abigen;

// We abigen the contract bindings from json definitions
abigen!(
    SeaportValidator,
    "../abi/ISeaportOneOneValidator.json",
    derives(serde::Deserialize, serde::Serialize)
);
