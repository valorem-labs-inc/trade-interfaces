use ethers::contract::abigen;

// We abigen the contract bindings from json definitions
abigen!(
    DomainRegistry,
    "../abi/ISeaportDomainRegistry.json",
    derives(serde::Deserialize, serde::Serialize)
);
