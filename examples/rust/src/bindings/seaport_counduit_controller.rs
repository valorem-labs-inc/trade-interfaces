use ethers::contract::abigen;

// We abigen the contract bindings from json definitions
abigen!(
    ConduitController,
    "../abi/ISeaportConduitController.json",
    derives(serde::Deserialize, serde::Serialize)
);
