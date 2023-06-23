use ethers::contract::abigen;

abigen!(
    Erc1155,
    "../abi/IERC1155.json",
    derives(serde::Deserialize, serde::Serialize)
);
